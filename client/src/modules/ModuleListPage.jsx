import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Plus, Search, SearchX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useSession } from '../auth/useAuth.js';
import { cn, formatDateTime } from '../lib/format.js';
import { moduleIcon } from '../lib/icons.js';
import { useUi } from '../store/ui.js';
import { Button, Card, EmptyState, PageHeader, Skeleton } from '../ui/core.jsx';
import { Input, Select } from '../ui/form.jsx';
import { Sheet } from '../ui/overlay.jsx';
import { FieldValue } from './FieldValue.jsx';
import { RecordForm } from './RecordForm.jsx';
import { useModuleMeta, useRecords } from './useModules.js';

const PAGE_SIZE = 25;
const CREATED_AT = { key: 'createdAt', type: 'date', label: 'Created' };

const useDebounced = (value, ms = 300) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

export const ModuleListPage = () => {
  const { module: name } = useParams();
  const navigate = useNavigate();
  const ctx = useSession();
  const plantId = useUi((s) => s.plantId);
  const { data: meta, isLoading: metaLoading } = useModuleMeta(name);
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text);
  const [creating, setCreating] = useState(false);

  const page = Number(params.get('page') ?? 1);
  const sort = params.get('sort') ?? '';
  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the debounced text should trigger the URL sync
  useEffect(() => {
    if ((params.get('q') ?? '') !== q) update({ q, page: '' });
  }, [q]);

  const columns = useMemo(() => {
    if (!meta) return [];
    const byKey = Object.fromEntries(meta.fields.map((f) => [f.key, f]));
    return meta.list.map((key) => (key === 'createdAt' ? CREATED_AT : byKey[key])).filter(Boolean);
  }, [meta]);
  const enumFilters = useMemo(() => columns.filter((c) => c.type === 'enum').slice(0, 3), [columns]);

  const filter = {};
  for (const f of enumFilters) if (params.get(f.key)) filter[f.key] = params.get(f.key);
  if (meta?.plantScoped && plantId && !ctx?.plantLocked) filter.plantId = plantId;

  const { data, isLoading, isFetching, isError, error } = useRecords(
    name,
    { q: q || undefined, filter, sort: sort || undefined, page, limit: PAGE_SIZE },
    { enabled: Boolean(meta) },
  );

  if (metaLoading)
    return (
      <div className="p-6">
        <Skeleton className="h-8 w-60" />
      </div>
    );
  if (!meta) {
    return (
      <EmptyState icon={SearchX} title="Module not found">
        This module doesn't exist or isn't enabled for your company.
      </EmptyState>
    );
  }

  const Icon = moduleIcon(meta.icon);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const toggleSort = (key) => {
    const next = sort === key ? `-${key}` : sort === `-${key}` ? '' : key;
    update({ sort: next, page: '' });
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <PageHeader
        icon={Icon}
        title={meta.label}
        description={meta.description}
        actions={
          meta.can.create && (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              New {meta.singular.toLowerCase()}
            </Button>
          )
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-52 flex-1 sm:max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <Input
              aria-label={`Search ${meta.label}`}
              placeholder={`Search ${meta.label.toLowerCase()}…`}
              className="pl-9"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {enumFilters.map((f) => (
            <Select
              key={f.key}
              aria-label={f.label}
              value={params.get(f.key) ?? ''}
              onChange={(e) => update({ [f.key]: e.target.value, page: '' })}
              className="w-auto min-w-36"
            >
              <option value="">Any {f.label.toLowerCase()}</option>
              {f.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          ))}
          <span className="ml-auto text-xs text-subtle tabular" aria-live="polite">
            {isFetching ? 'Loading…' : data ? `${data.total} ${data.total === 1 ? 'record' : 'records'}` : ''}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-muted">
              <tr>
                {columns.map((c) => {
                  const dir = sort === c.key ? 'asc' : sort === `-${c.key}` ? 'desc' : null;
                  const sortable = !['refs', 'tags', 'array', 'object'].includes(c.type);
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className="px-4 py-2.5 font-medium whitespace-nowrap"
                      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          className="inline-flex items-center gap-1 hover:text-fg"
                        >
                          {c.label}
                          {dir === 'asc' && <ArrowUp className="size-3" />}
                          {dir === 'desc' && <ArrowDown className="size-3" />}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading &&
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c.key} className="px-4 py-3">
                        <Skeleton className="h-4 w-24" />
                      </td>
                    ))}
                  </tr>
                ))}
              {data?.items.map((row) => (
                <tr
                  key={row._id}
                  tabIndex={0}
                  onClick={() => navigate(`/m/${name}/${row._id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/m/${name}/${row._id}`)}
                  className="cursor-pointer transition-colors hover:bg-surface-2/70 focus:bg-surface-2 focus:outline-none"
                >
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={cn(
                        'max-w-72 px-4 py-2.5',
                        i === 0 && 'font-medium whitespace-nowrap text-fg',
                      )}
                    >
                      {c === CREATED_AT ? (
                        <span className="tabular whitespace-nowrap text-muted">
                          {formatDateTime(row.createdAt)}
                        </span>
                      ) : (
                        <FieldValue meta={c} value={row[c.key]} compact />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {isError && <p className="p-6 text-sm text-critical">{error.message}</p>}
          {data && data.items.length === 0 && (
            <EmptyState
              title={
                q || Object.keys(filter).length ? 'Nothing matches' : `No ${meta.label.toLowerCase()} yet`
              }
            >
              {q || Object.keys(filter).length
                ? 'Try a different search or clear the filters.'
                : `Create one here, or ask SARA to do it for you.`}
            </EmptyState>
          )}
        </div>

        {data && data.total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted">
            <span className="tabular">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-1">
              <Button
                size="iconSm"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => update({ page: page - 1 })}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                size="iconSm"
                variant="ghost"
                disabled={page >= totalPages}
                onClick={() => update({ page: page + 1 })}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Sheet
        open={creating}
        onOpenChange={setCreating}
        title={`New ${meta.singular.toLowerCase()}`}
        width="max-w-2xl"
      >
        {creating && (
          <RecordForm
            meta={meta}
            onCancel={() => setCreating(false)}
            onDone={(item) => {
              setCreating(false);
              navigate(`/m/${name}/${item._id}`);
            }}
          />
        )}
      </Sheet>
    </div>
  );
};
