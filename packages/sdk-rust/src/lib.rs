pub struct Client {
    pub base_url: String,
    pub http_client: reqwest::Client,
}

impl Client {
    pub fn new(base_url: String) -> Self {
        Client {
            base_url,
            http_client: reqwest::Client::new(),
        }
    }
}

