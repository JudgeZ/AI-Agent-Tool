import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Use SVELTE_ADAPTER=node to opt into serverful deployments; default stays static for browser-only builds.
const adapterChoice = process.env.SVELTE_ADAPTER?.trim().toLowerCase();
if (adapterChoice && adapterChoice !== 'node' && adapterChoice !== 'static') {
  console.warn(
    `Unknown SVELTE_ADAPTER value: "${adapterChoice}". Valid values: "node", "static". Defaulting to static.`
  );
}
const useNodeAdapter = adapterChoice === 'node';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: useNodeAdapter
      ? adapterNode({ precompress: true })
      : adapterStatic({
          pages: 'build',
          assets: 'build',
          fallback: 'index.html',
          precompress: false,
          strict: true
        })
  }
};

export default config;
