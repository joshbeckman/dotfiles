# Message rendering specimen

A compact test page inspired by [your Markdown test page](https://www.joshbeckman.org/blog/test). This is deliberately varied content for inspecting Pana’s message typography—not a proposed visual design.

This second paragraph should have a visible gap from the first, even though neither contains a manual line break.

## Heading hierarchy and spacing

Body text immediately below a section heading should feel attached to that heading, while the next section should have more space above it.

### A subsection with Mixed Case and `inline code`

A normal paragraph with **strong emphasis**, *italics*, ***both together***, ~~deleted text~~, and a [descriptive link](https://www.joshbeckman.org/blog/test).

#### Level four heading

Short supporting text.

##### Level five heading

Short supporting text.

###### Level six heading

Short supporting text.

## A longer heading that should wrap naturally on a narrow phone screen without colliding with the text below

This paragraph follows a wrapped heading. The line height and spacing should work for both one-line and multi-line headings.

## Consecutive headings
### Subheading without intervening prose
#### Another level without intervening prose

These headings should form a clear hierarchy, rather than a stack of visually unrelated labels.

## Lists and nesting

- A short item.
- An item with enough prose to wrap onto another line on a phone, keeping the continuation aligned with the item text rather than with its bullet.
  - A nested item.
  - Another nested item with **bold text**.
- A final item.

1. First ordered item.
2. Second ordered item.

   A second paragraph inside this item should remain visibly associated with item two.

   > A quotation inside a list item.

3. Third ordered item.

- [x] A completed task.
- [ ] A remaining task with a label long enough to wrap on a narrow screen.

## Quotations

> A quotation should have a modest indent, a visible left rule, and consistent paragraph spacing.
>
> This is the second paragraph in the same quote.
>
> > Nested quotation, not a new message.

A normal paragraph after the quote.

## Code and long tokens

Inline code such as `pana thread read THREAD` should be distinct from ordinary text without overpowering it.

```typescript
const message = { heading: "Preserve Mixed Case", readable: true };
console.log(message);
```

```text
A deliberately long preformatted line: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega END
```

A long unbroken token should wrap without widening the message: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789

## Tables

| Element | Expected behavior | Status |
| :--- | :---: | ---: |
| Heading | Clear hierarchy | Inspect |
| Paragraph | Visible separation | Inspect |
| `inline code` | Distinct treatment | Inspect |

| Wide table | Description | Another column | Yet another column | Final column |
| --- | --- | --- | --- | --- |
| abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 | Content should remain readable | Prefer local horizontal scrolling | Do not squeeze every word into a vertical stack | Keep message actions reachable |

## Rules and line breaks

Text before a horizontal rule.

---

Text after the rule. A single source newline
continues the same paragraph.

This line ends with two spaces.  
This should be a deliberate line break.

## Images

![Small test image: the Pana icon](/icon-192.png)

The image should not stretch to fill the message. Its surrounding paragraph spacing should match other blocks.

## End of specimen

The last paragraph should not leave an extra blank band at the bottom of the message card.
