import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { AssistantMarkdown } from './AssistantMarkdown';

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
