---
description: Open Last Response as GitHub Gist
allowed-tools: Bash(gh gist:*), Write, Bash(mktemp:*), Bash(rm:*), Bash(open:*)
---

Please take your last response and create a GitHub gist with it.

Do this by:
1. Taking the full content of your previous response
2. Creating a temporary markdown file with the content
3. Creating a gist using: `gh gist create --public --desc "Claude Response" --filename "response.md" <temp_file>`
4. Opening the gist URL in the browser

Make sure to:
- Preserve all markdown formatting (headers, lists, code blocks, links, etc.)
- Include any code blocks with proper language identifiers
- Keep all line breaks and whitespace
- Use a descriptive filename that reflects the content if possible
- Clean up the temporary file after creating the gist

Just run the commands directly without explanation.
