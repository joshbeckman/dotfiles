---
name: information-design
description: 'Tufte-informed information design for shared documentation. Use when: (1) writing docs, reports, proposals, or READMEs, (2) creating tables, charts, or diagrams, (3) formatting any content for an audience. Principle: maximize density, minimize noise.'
---

# Information Design

*Principles from Edward Tufte, applied to documentation.*

## Core Principle

**Maximize information conveyed per unit of reader attention.** Every word, line, element, and formatting choice must earn its place. If removing it loses no information, remove it.

## The Test

For every element, ask:

1. Does this add information the reader doesn't already have?
2. Is this the densest format for this information?
3. Would a table, list, or inline mention be denser?

If #1 is no, delete it. If #2 or #3 suggest alternatives, use them.

## Principles

| Tufte Principle | Applied to Documentation |
|---|---|
| **Data-ink ratio** | Every word carries meaning. Cut filler, transitions, restated context. |
| **Chartjunk** | No decorative formatting, emoji, ornamental headers, or gratuitous rules. |
| **Smallest effective difference** | Minimum formatting needed. Bold alone, not bold + italic + color. |
| **Small multiples** | Parallel structure. Consistent repeated patterns let readers compare without re-learning layout. |
| **1+1=3** | Unnecessary borders, separators, and whitespace create visual noise. Let content create structure. |
| **Adjacent in space** | Related information together. Don't separate data from explanation. Tables over sequential paragraphs. |
| **Respect the audience** | Assume intelligence. Don't define known terms or add "as you know" context. |

## Format Selection

Choose the densest format that fits the data:

| Data Shape | Use | Not |
|---|---|---|
| Items compared across attributes | Table | Sequential paragraphs |
| Ordered steps with dependencies | Numbered list | Prose paragraphs |
| Independent items | Bullet list | Numbered list |
| Single if → then | Inline text | Table with 2 rows |
| 2-column numeric data | Table | Bar chart |
| Trend over many time points | Line chart or sparkline | Table of numbers |
| Part-to-whole (2-5 parts) | Sentence with percentages | Pie chart |
| Hierarchy / taxonomy | Indented list or tree | Nested paragraphs |
| Relationships with branching/cycles | Diagram (mermaid) | Prose description |
| Linear sequence, no branching | Numbered list | Flowchart |

**Default to text and tables.** Charts and diagrams earn their place only when they reveal structure that text cannot.

## Diagrams

Use diagrams only when the structure has **branching, cycles, or spatial relationships** that a list or table cannot convey. A flowchart for a linear sequence is chartjunk.

**Mermaid guidelines:**

| Principle | Do | Don't |
|---|---|---|
| Direction | `graph LR` (reads naturally left-to-right) | `graph TD` unless hierarchy is the point |
| Nodes | Short labels, 2-4 words | Full sentences in nodes |
| Edges | Label edges to show relationships | Rely on node names to imply connections |
| Styling | Default styles, no color unless encoding data | `style` blocks for decoration |
| Complexity | 3-10 nodes; split larger graphs | Single diagram with 20+ nodes |
| Obvious nodes | Collapse linear chains (A→B→C becomes A→C if B is implied) | Nodes that restate what edges say |
| Type | Simplest type that fits: `graph` before `sequenceDiagram` before `classDiagram` | Complex diagram types for simple relationships |

**When to split:** If a diagram needs a legend or paragraph of explanation to be understood, it's too complex. Break it into small multiples — several simple diagrams with consistent structure.

## Anti-Patterns

| Agent Pattern | Problem | Fix |
|---|---|---|
| "It is important to note that X" | 8 words before information starts | "X" |
| "Additionally, furthermore, moreover" | Transition without information | Start the next point |
| Restating what was just said | Zero new information | Delete |
| Section header for 2-3 sentences | More chrome than content | Merge into adjacent section |
| Paragraph describing the table below | Reader will see the table | Delete or one-line lead-in |
| 5-bar chart for 5 numbers | Chart overhead exceeds data | 2-column table or inline text |
| Bold + italic + uppercase | Three emphasis levels | One: bold |
| "In this document, we will..." | Meta-commentary about the document | Start with content |
| Emoji as section markers | Decoration | Remove |
| "As mentioned above/below" | Breaks on reformat | Name the thing directly |
| Flowchart for linear process | Diagram overhead for a list | Numbered list |
| Mermaid node: "User submits the login form" | Sentence in a box | Node: "Submit login" |

## Density Techniques

**Sentence:** Lead with information, not framing. One idea per sentence. Parentheticals for context most readers have: "The data-ink ratio (Tufte, 1983) measures..."

**Paragraph:** First sentence carries the thesis. If three paragraphs compare three things, convert to a table. No paragraph should exist that could be a row in a nearby table.

**Document:** Most important information first. No introduction that restates the title. Headings carry information: "Q2 Revenue Up 12%" not "Revenue Results." Table of contents only beyond 5 screens.

**Formatting:** Monospace for code and literal strings only. Bold for key terms on first use. Links as evidence, not decoration. White space serves structure, not aesthetics.

## Self-Check

Before sharing any document, review:

1. Cross out every sentence that adds no new information. If more than 10%, rewrite.
2. Every paragraph longer than 3 sentences: could this be a table?
3. Count formatting types used (bold, italic, headers, colors, rules). More than 3 types? Reduce.
4. Read only the headings. Do they tell the story alone? If not, rewrite them.
5. Every diagram: does it have branching or cycles? If not, replace with a list.
