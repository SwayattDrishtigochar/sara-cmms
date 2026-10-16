import { Download, FileText } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, apiUrl, getToken } from '../api/client.js';
import { cn } from '../lib/format.js';
import { Button } from '../ui/core.jsx';

const ORIGIN = import.meta.env.VITE_API_URL ?? '';

/** `/api/export/…` from the block, a bare `/export/…`, or a full URL. */
const resolve = (url) =>
  /^https?:/.test(url) ? url : url.startsWith('/api/') ? `${ORIGIN}${url}` : apiUrl(url);

/** Fetches a protected file with the bearer token and hands it to the browser as a download. */
export const downloadFile = async (url, name) => {
  const token = getToken();
  const res = await fetch(resolve(url), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const href = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};

/** `file` block: a CSV (or other export) the assistant produced. */
export const FileBlock = ({ name = 'export.csv', url, className }) => {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await downloadFile(url, name);
    } catch (err) {
      toast.error("Couldn't download the file", { description: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5',
        className,
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
        <FileText className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{name}</p>
        <p className="text-xs text-subtle">Ready to download</p>
      </div>
      <Button size="sm" icon={Download} loading={busy} onClick={download} disabled={!url}>
        Download
      </Button>
    </div>
  );
};
