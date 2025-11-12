# Tauri host prerequisites

The Rust crate under `apps/gui/src-tauri` wraps the SvelteKit frontend in a Tauri shell. Building it on Linux requires a handful of GTK and WebKit development headers in addition to the standard Rust toolchain.

## Linux packages

Install the packages below before running `cargo test --workspace` or compiling the desktop shell:

```bash
sudo apt-get update
sudo apt-get install -y \
  pkg-config \
  libgtk-3-dev \
  libglib2.0-dev \
  libatk1.0-dev \
  libgdk-pixbuf-2.0-dev \
  libcairo2-dev \
  libpango1.0-dev \
  libsoup2.4-dev \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev
```

These packages align with the upstream [Tauri Linux prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites/#setting-up-linux) and mirror the configuration used in CI.

## Working without desktop dependencies

When you cannot install the GUI toolchain (for example, inside a minimal container), skip the desktop crate during Rust workflows:

```bash
cargo test --workspace --exclude apps/gui/src-tauri
```

The rest of the workspace (including `services/indexer`) continues to compile and test normally.
