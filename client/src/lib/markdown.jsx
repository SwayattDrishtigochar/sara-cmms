import { Check, Copy } from 'lucide-react';
import { Children, isValidElement, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { copyText } from '../superadmin/simUtils.js';
import { cn } from './format.js';

const PROSE =
  'text-sm leading-relaxed text-fg break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mt-4 [&_h1]:mb-1.5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li>p]:my-0.5 [&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_hr]:my-4 [&_hr]:border-border [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:w-full [&_table]:text-xs [&_thead]:bg-surface-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted [&_td]:border-t [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top [&_img]:max-w-full [&_img]:rounded-lg';

/** App paths (e.g. /machines/<id> from a tool link) stay in the SPA; everything else opens a new tab. */
const Anchor = ({ node: _node, href = '', ...props }) =>
  href.startsWith('/') && !/^\/(\/|api\/)/.test(href) ? (
    <Link to={href} {...props} />
  ) : (
    <a href={href} {...props} target="_blank" rel="noreferrer" />
  );

const Table = ({ node: _node, ...props }) => (
  <div className="my-2 overflow-x-auto rounded-lg border border-border scrollbar-thin">
    <table {...props} />
  </div>
);

const textOf = (children) =>
  Children.toArray(children)
    .map((c) => (typeof c === 'string' ? c : isValidElement(c) ? textOf(c.props.children) : ''))
    .join('');

/** Fenced code: language label and a copy button above the block. */
const Pre = ({ node: _node, children }) => {
  const code = Children.toArray(children).find(isValidElement);
  const lang = /language-([\w-]+)/.exec(code?.props?.className ?? '')?.[1];
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () =>
    copyText(textOf(code?.props?.children).replace(/\n$/, ''))
      .then(() => setCopied(true))
      .catch(() => {});
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-[11px] text-subtle">
        <span className="font-mono">{lang ?? 'text'}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-surface-3 hover:text-fg"
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed scrollbar-thin">{children}</pre>
    </div>
  );
};

const COMPONENTS = { a: Anchor, table: Table, pre: Pre };

/** GitHub-flavoured markdown from the assistant: styled tables, code blocks with copy, external links. */
export const Markdown = ({ children, className }) => (
  <div className={cn(PROSE, className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  </div>
);
