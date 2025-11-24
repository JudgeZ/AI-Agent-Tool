import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const adapterChoice = process.env.SVELTE_ADAPTER?.trim().toLowerCase();
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
