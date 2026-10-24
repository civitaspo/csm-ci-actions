import { CARGO_TARGETS } from "../lib/config.ts";

export const CARGO_RUNNERS = {
  "aarch64-apple-darwin": "macos-15",
  "aarch64-unknown-linux-gnu": "ubuntu-24.04-arm",
  "x86_64-apple-darwin": "macos-15-intel",
  "x86_64-pc-windows-msvc": "windows-2022",
  "x86_64-unknown-linux-gnu": "ubuntu-24.04",
} satisfies Record<(typeof CARGO_TARGETS)[number], string>;
