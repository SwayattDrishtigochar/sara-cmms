import { Braces } from 'lucide-react';
import { Component } from 'react';
import { ConfirmCard } from '../chat/ConfirmCard.jsx';
import { KpiPreviewBlock } from '../kpis/KpiPreviewBlock.jsx';
import { cn, humanize } from '../lib/format.js';
import { PlanBlock } from '../planner/PlanBlock.jsx';
import { CopyButton } from '../superadmin/parts.jsx';
import { ChartBlock } from './ChartBlock.jsx';
import { DataTable } from './DataTable.jsx';
import { FileBlock } from './FileBlock.jsx';
import { KpiBlock } from './KpiBlock.jsx';
import { NavigateBlock } from './NavigateBlock.jsx';

/** Any block the client does not know, shown as tidy JSON. */
export const JsonBlock = ({ type, payload, note, className }) => {
  const text = JSON.stringify(payload ?? null, null, 2);
  return (
    <figure className={cn('overflow-hidden rounded-xl border border-border bg-surface', className)}>
      <figcaption className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
          <Braces className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{payload?.title ?? humanize(type ?? 'block')}</span>
        </span>
        <CopyButton text={text} label="Copy JSON" iconOnly variant="ghost" />
      </figcaption>
      {note && <p className="border-b border-border px-3 py-1.5 text-xs text-subtle">{note}</p>}
      <pre className="max-h-72 overflow-auto p-3 font-mono text-xs leading-relaxed text-muted scrollbar-thin">
        {text}
      </pre>
    </figure>
  );
};

/** A block whose payload breaks its renderer falls back to JSON instead of taking the thread down. */
class BlockBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    const { failed } = this.state;
    const { type, payload, children } = this.props;
    return failed ? (
      <JsonBlock type={type} payload={payload} note="This block couldn't be drawn; here is its data." />
    ) : (
      children
    );
  }
}

/** Type and payload of a block part, stored (`{ type: 'block', blockType, payload }`) or nested (`block`). */
export const blockOf = (part) => ({
  id: part.id ?? part.block?.id,
  type: part.blockType ?? part.block?.type ?? part.kind,
  payload: part.payload ?? part.block?.payload ?? {},
});

/**
 * Renders one assistant block by type. `messageId` builds the CSV export URL of `file` blocks; `confirm` =
 * { action, onConfirm, onReject } for the message's pending write.
 */
export const BlockRenderer = ({ part, messageId, confirm }) => {
  const { id, type, payload } = blockOf(part);
  let body;
  switch (type) {
    case 'table':
      body = <DataTable {...payload} />;
      break;
    case 'chart':
      body = <ChartBlock {...payload} />;
      break;
    case 'kpis':
      body = <KpiBlock {...payload} />;
      break;
    case 'file':
      body = (
        <FileBlock
          name={payload.name}
          url={payload.url ?? (messageId && id ? `/api/export/${messageId}/${id}.csv` : undefined)}
        />
      );
      break;
    case 'confirm':
      body = <ConfirmCard payload={payload} {...confirm} />;
      break;
    case 'plan':
      body = <PlanBlock payload={payload} />;
      break;
    case 'kpi':
      body = <KpiPreviewBlock payload={payload} />;
      break;
    case 'navigate':
      body = <NavigateBlock id={id} {...payload} />;
      break;
    default:
      body = <JsonBlock type={type} payload={payload} />;
  }
  return (
    <BlockBoundary type={type} payload={payload}>
      {body}
    </BlockBoundary>
  );
};
