---
description: Create quick.shopify.io Demo of Last Response
allowed-tools: Bash(quick:*), Write, Bash(mktemp:*), Bash(rm:*), Bash(open:*)
---

Please take your last response and create an interactive demonstration on quick.shopify.io.

Analyze the content and choose the most appropriate format:
1. **For data/tables**: Create an interactive HTML table with sorting/filtering using vanilla JS
2. **For visualizations/charts**: Create interactive charts using Chart.js or D3.js via CDN
3. **For UI components/prototypes**: Create a Polaris-based interactive prototype
4. **For code examples**: Create a live code playground with syntax highlighting
5. **For explanations/text**: Create a styled markdown-like HTML page with good typography
6. **For processes/workflows**: Create an interactive step-by-step visualization

Do this by:
1. Analyzing your previous response to determine the best presentation format
2. Creating a temporary directory with `mktemp -d`
3. Running `quick init` in that directory to set up the project (read the resulting files like `AGENTS.md`)
  - If the `quick` CLI is not installed, run `npm install -g @shopify/quick`
4. Writing an index.html file with the appropriate interactive demonstration
5. Including any necessary CSS and JavaScript inline or via CDN
6. Deploying from within the directory with: `quick deploy . claude-joshbeckman-$(date +%s) --force`
7. Opening the deployed URL in the browser
8. Cleaning up the temporary directory

Make sure to:
- Use modern, responsive design
- Include interactive elements where appropriate (hover effects, clickable elements, filters)
- Use Shopify Polaris design tokens/colors where applicable
- Make it mobile-friendly
- Include a title that describes what's being demonstrated
- Add any necessary interactivity to enhance understanding

Just run the commands directly without explanation.
