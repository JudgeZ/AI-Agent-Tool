#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use hf_hub::{api::sync::Api, Repo, RepoType};
use thiserror::Error;
use tokenizers::Tokenizer;
use tokio::task;

#[derive(Debug, Error)]
pub enum EmbeddingError {
    #[error("embedding generation failed: {0}")]
    Generation(String),
    #[error("model loading failed: {0}")]
    ModelLoad(String),
    #[error("HTTP client error: {0}")]
    HttpClient(String),
}

pub const EMBEDDING_DIM: usize = 384;

#[derive(Clone, Debug)]
pub struct EmbeddingConfig {
    pub provider: String,
    pub model_path: Option<String>,
}

#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;
}

struct BertModelWrapper {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl BertModelWrapper {
    fn new() -> Result<Self, EmbeddingError> {
        let device = Device::Cpu; // Use CPU for now, can be configured for CUDA/Metal

        let api = Api::new().map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;
        let repo = api.repo(Repo::new(
            "sentence-transformers/all-MiniLM-L6-v2".to_string(),
            RepoType::Model,
        ));

        let config_filename = repo
            .get("config.json")
            .map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;
        let tokenizer_filename = repo
            .get("tokenizer.json")
            .map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;
        let weights_filename = repo
            .get("model.safetensors")
            .map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;

        let config = std::fs::read_to_string(config_filename)
            .map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;
        let config: Config =
            serde_json::from_str(&config).map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;

        let tokenizer = Tokenizer::from_file(tokenizer_filename)
            .map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;

        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_filename], DTYPE, &device)
                .map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?
        };

        let model =
            BertModel::load(vb, &config).map_err(|e| EmbeddingError::ModelLoad(e.to_string()))?;

        Ok(Self {
            model,
            tokenizer,
            device,
        })
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let tokens = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?;

        let token_ids = Tensor::new(tokens.get_ids(), &self.device)
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?
            .unsqueeze(0)
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?;

        let token_type_ids = token_ids
            .zeros_like()
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?;

        let embeddings = self
            .model
            .forward(&token_ids, &token_type_ids) // Fixed: removed None argument
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?;

        // Mean pooling
        let dims = embeddings.dims();
        let n_tokens = dims[1];

        let embeddings = (embeddings
            .sum(1)
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?
            / (n_tokens as f64))
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?;

        let embeddings =
            normalize_l2(&embeddings).map_err(|e| EmbeddingError::Generation(e.to_string()))?;

        let embedding_vec = embeddings
            .squeeze(0)
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?
            .to_vec1::<f32>()
            .map_err(|e| EmbeddingError::Generation(e.to_string()))?;

        Ok(embedding_vec)
    }
}

fn normalize_l2(v: &Tensor) -> candle_core::Result<Tensor> {
    let sum_sq = v.sqr()?.sum_keepdim(1)?;
    let norm = sum_sq.sqrt()?;
    v.broadcast_div(&norm)
}

pub struct LocalBertProvider {
    // Wrap in Arc<Mutex> because BertModel is not Sync/Send by default (due to internal caches/buffers potentially)
    // Actually candle models are usually stateless or immutable after load, but let's be safe.
    // However, we need to share it across threads.
    model: Arc<Mutex<BertModelWrapper>>,
}

impl LocalBertProvider {
    pub fn new() -> Result<Self, EmbeddingError> {
        // Load model in a blocking task
        let wrapper = task::block_in_place(BertModelWrapper::new)?;
        Ok(Self {
            model: Arc::new(Mutex::new(wrapper)),
        })
    }
}

#[async_trait]
impl EmbeddingProvider for LocalBertProvider {
    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let model = self.model.clone();
        let text = text.to_string();

        task::spawn_blocking(move || {
            let wrapper = model
                .lock()
                .map_err(|_| EmbeddingError::Generation("mutex poisoned".to_string()))?;
            wrapper.embed(&text)
        })
        .await
        .map_err(|e| EmbeddingError::Generation(format!("task join error: {e}")))?
    }
}

pub struct OrchestratorProvider {
    client: reqwest::Client,
    base_url: String,
}

impl OrchestratorProvider {
    pub fn new(base_url: Option<String>) -> Result<Self, EmbeddingError> {
        let base_url = base_url.unwrap_or_else(|| {
            std::env::var("ORCHESTRATOR_URL")
                .unwrap_or_else(|_| "http://localhost:8080".to_string())
        });

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| {
                EmbeddingError::HttpClient(format!("failed to create HTTP client: {e}"))
            })?;

        Ok(Self { client, base_url })
    }
}

#[async_trait]
impl EmbeddingProvider for OrchestratorProvider {
    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let url = format!("{}/api/v1/embeddings", self.base_url);
        let response = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "text": text }))
            .send()
            .await
            .map_err(|e| EmbeddingError::Generation(format!("HTTP request failed: {e}")))?;

        if !response.status().is_success() {
            return Err(EmbeddingError::Generation(format!(
                "HTTP error: {}",
                response.status()
            )));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| EmbeddingError::Generation(format!("failed to parse response: {e}")))?;

        let embedding = json
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or_else(|| EmbeddingError::Generation("invalid response format".to_string()))?
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect::<Vec<f32>>();

        if embedding.len() != EMBEDDING_DIM {
            return Err(EmbeddingError::Generation(format!(
                "expected embedding dimension {}, got {}",
                EMBEDDING_DIM,
                embedding.len()
            )));
        }

        Ok(embedding)
    }
}

pub enum EmbeddingManager {
    Local(LocalBertProvider),
    Orchestrator(OrchestratorProvider),
}

impl EmbeddingManager {
    pub fn new(provider_type: Option<&str>) -> Result<Self, EmbeddingError> {
        match provider_type {
            Some("orchestrator") | None => {
                // Default to orchestrator if ORCHESTRATOR_URL is set, otherwise local
                let orchestrator_url = std::env::var("ORCHESTRATOR_URL").ok();
                if orchestrator_url.is_some() || provider_type == Some("orchestrator") {
                    Ok(EmbeddingManager::Orchestrator(OrchestratorProvider::new(
                        orchestrator_url,
                    )?))
                } else {
                    Ok(EmbeddingManager::Local(LocalBertProvider::new()?))
                }
            }
            Some("local") => Ok(EmbeddingManager::Local(LocalBertProvider::new()?)),
            Some(other) => Err(EmbeddingError::Generation(format!(
                "unknown provider type: {other}"
            ))),
        }
    }

    pub async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        match self {
            EmbeddingManager::Local(provider) => provider.embed(text).await,
            EmbeddingManager::Orchestrator(provider) => provider.embed(text).await,
        }
    }
}
