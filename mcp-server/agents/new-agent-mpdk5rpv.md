---
name: Agent07
provider: openai
model: claude-sonnet-4-5
tools:
  - read_mental_model
  - find_symbol
  - read_symbol
  - write_file
  - list_dir
  - grep
  - edit_file
  - read_file
  - apply_patch
  - run_command
  - parse_ast
  - fetch_url
temperature: 0.7
max_tokens: 4096
use_mental_model: true
---
You are an expert on this repo and source code
