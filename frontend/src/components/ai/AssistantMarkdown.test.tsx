import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { AssistantMarkdown } from './AssistantMarkdown';
import { AI_ENTITY_LINK_EVENT } from '@/lib/ai-entity-links';

describe('AssistantMarkdown', () => {
  it('renders plain text as a paragraph', () => {
    render(<AssistantMarkdown content="Hello world" />);
    const paragraph = screen.getByText('Hello world');
    expect(paragraph).toBeInTheDocument();
    expect(paragraph.tagName).toBe('P');
  });

  it('renders bold text with <strong>', () => {
    const { container } = render(
      <AssistantMarkdown content="This is **important**" />,
    );
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('important');
    expect(strong?.className).toContain('font-semibold');
  });

  it('renders italic text with <em>', () => {
    const { container } = render(
      <AssistantMarkdown content="This is *emphasized*" />,
    );
    const em = container.querySelector('em');
    expect(em).not.toBeNull();
    expect(em?.textContent).toBe('emphasized');
  });

  it('renders an unordered list', () => {
    const { container } = render(
      <AssistantMarkdown content={'- Apples\n- Oranges\n- Bananas'} />,
    );
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    expect(ul?.className).toContain('list-disc');
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toBe('Apples');
    expect(items[2].textContent).toBe('Bananas');
  });

  it('renders a Unicode-bullet (•) list as a real list, not one paragraph', () => {
    // LLMs often emit literal • bullets; without normalisation CommonMark
    // collapses them into a single paragraph (the "all on one line" bug).
    const { container } = render(
      <AssistantMarkdown
        content={'Rules:\n• Salary → Pay\n• Bonus → Reward\n• Overtime → Extra'}
      />,
    );
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Salary');
    expect(items[2].textContent).toContain('Overtime');
    // The literal bullet glyph must not survive into the rendered text.
    expect(container.textContent).not.toContain('•');
  });

  it('leaves a mid-sentence bullet glyph untouched', () => {
    const { container } = render(
      <AssistantMarkdown content="Use the • symbol carefully" />,
    );
    expect(container.querySelector('ul')).toBeNull();
    expect(container.textContent).toContain('•');
  });

  it('renders an ordered list', () => {
    const { container } = render(
      <AssistantMarkdown content={'1. First\n2. Second\n3. Third'} />,
    );
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect(ol?.className).toContain('list-decimal');
    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('renders headings at each level', () => {
    const { container } = render(
      <AssistantMarkdown content={'# H1\n\n## H2\n\n### H3'} />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('H1');
    expect(container.querySelector('h2')?.textContent).toBe('H2');
    expect(container.querySelector('h3')?.textContent).toBe('H3');
  });

  it('renders inline code with monospace styling', () => {
    const { container } = render(
      <AssistantMarkdown content="Run `npm test` to verify" />,
    );
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('npm test');
    expect(code?.className).toContain('font-mono');
  });

  it('renders fenced code blocks inside <pre>', () => {
    const content = '```\nconst x = 1;\n```';
    const { container } = render(<AssistantMarkdown content={content} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('const x = 1;');
  });

  it('renders links with target _blank and rel noopener', () => {
    const { container } = render(
      <AssistantMarkdown content="[Docs](https://example.com)" />,
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe('Docs');
  });

  describe('entity deep-links (monize:// hrefs)', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';

    it('renders a payee link as an in-app link without target _blank', () => {
      const { container } = render(
        <AssistantMarkdown content={`Top payee: [Costco](monize://payee/${uuid})`} />,
      );
      const link = container.querySelector('a');
      expect(link).not.toBeNull();
      expect(link?.getAttribute('href')).toBe(`/transactions?payeeId=${uuid}`);
      expect(link?.getAttribute('target')).toBeNull();
      expect(link?.textContent).toBe('Costco');
    });

    it('maps account, category, transaction, security, and scheduled links to their URLs', () => {
      const { container } = render(
        <AssistantMarkdown
          content={[
            `[Chequing](monize://account/${uuid})`,
            `[Groceries](monize://category/${uuid})`,
            `[March rent](monize://transaction/${uuid})`,
            `[AAPL](monize://security/${uuid})`,
            `[Netflix](monize://scheduled/${uuid})`,
          ].join(' ')}
        />,
      );
      const hrefs = [...container.querySelectorAll('a')].map((a) =>
        a.getAttribute('href'),
      );
      expect(hrefs).toEqual([
        `/transactions?accountId=${uuid}&accountStatus=all`,
        `/transactions?categoryId=${uuid}`,
        `/transactions?targetTransactionId=${uuid}`,
        `/securities?highlight=${uuid}`,
        `/bills?highlight=${uuid}`,
      ]);
    });

    it('dispatches the entity link event on click', () => {
      const { container } = render(
        <AssistantMarkdown content={`[Costco](monize://payee/${uuid})`} />,
      );
      const handler = vi.fn();
      window.addEventListener(AI_ENTITY_LINK_EVENT, handler);
      fireEvent.click(container.querySelector('a')!);
      window.removeEventListener(AI_ENTITY_LINK_EVENT, handler);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('renders an invalid monize URI as plain text, not a link', () => {
      const { container } = render(
        <AssistantMarkdown
          content={
            'A [bad id](monize://payee/not-a-uuid) and a [bad type](monize://widget/123e4567-e89b-42d3-a456-426614174000)'
          }
        />,
      );
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toContain('bad id');
      expect(container.textContent).toContain('bad type');
    });

    it('keeps external links opening in a new tab (default sanitizer intact)', () => {
      const { container } = render(
        <AssistantMarkdown
          content={`[Docs](https://example.com) and [Costco](monize://payee/${uuid})`}
        />,
      );
      const links = [...container.querySelectorAll('a')];
      expect(links).toHaveLength(2);
      expect(links[0].getAttribute('target')).toBe('_blank');
      expect(links[1].getAttribute('target')).toBeNull();
    });
  });

  it('renders GFM tables (via remark-gfm)', () => {
    const content =
      '| Category | Amount |\n| --- | --- |\n| Food | $100 |\n| Gas | $50 |';
    const { container } = render(<AssistantMarkdown content={content} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('$100')).toBeInTheDocument();
  });

  it('renders GFM strikethrough', () => {
    const { container } = render(
      <AssistantMarkdown content="This is ~~removed~~" />,
    );
    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del?.textContent).toBe('removed');
  });

  it('renders blockquotes', () => {
    const { container } = render(
      <AssistantMarkdown content="> A quoted line" />,
    );
    const blockquote = container.querySelector('blockquote');
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent?.trim()).toBe('A quoted line');
  });

  it('renders horizontal rules', () => {
    const { container } = render(
      <AssistantMarkdown content={'Before\n\n---\n\nAfter'} />,
    );
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders empty content without crashing', () => {
    const { container } = render(<AssistantMarkdown content="" />);
    expect(container).toBeInTheDocument();
  });
});
