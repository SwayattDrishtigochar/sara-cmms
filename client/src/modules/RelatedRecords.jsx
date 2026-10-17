import { ChevronLeft, ChevronRight, Link2, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { cn, formatDateTime } from '../lib/format.js';
import { Button, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { Sheet, TabPanel, Tabs } from '../ui/overlay.jsx';
import { FieldValue } from './FieldValue.jsx';
import { RecordForm } from './RecordForm.jsx';
import { useModuleMeta } from './useModules.js';
import { useRelated, useRelatedCounts } from './useRelated.js';

const PAGE_SIZE = 25;
const CREATED_AT = { key: 'createdAt', type: 'date', label: 'Created' };

/** "Add <child>" button with its form sheet, the parent pre-filled; nothing when the user can't create. */
export const AddChild = ({ record, child }) => {
  const { data: meta } = useModuleMeta(child?.module);
  const [adding, setAdding] = useState(false);
  if (!meta || !child.can?.create || !meta.can.create) return null;
  const singular = meta.singular.toLowerCase();
  const field = meta.fields.find((f) => f.key === child.field);
  return (
    <>
      <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
        Add {singular}
      </Button>
      <Sheet open={adding} onOpenChange={setAdding} title={`New ${singular}`} width="max-w-2xl">
        {adding && (
          <RecordForm
            meta={meta}
            defaults={{ [child.field]: field?.type === 'refs' ? [record] : record }}
            onCancel={() => setAdding(false)}
            onDone={() => setAdding(false)}
          />
        )}
      </Sheet>
    </>
  );
};

/** Table of one child relation: the child module's list columns, paged, with "Add" pre-filled. */
const RelatedTable = ({ parentMeta, record, child }) => {
  const navigate = useNavigate();
  const { data: meta } = useModuleMeta(child.module);
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error } = useRelated(parentMeta.name, record._id, child.module, {
    page,
    limit: PAGE_SIZE,
  });

  const columns = useMemo(() => {
    if (!meta) return [];
    const byKey = Object.fromEntries(meta.fields.map((f) => [f.key, f]));
    return meta.list
      .map((key) => (key === 'createdAt' ? CREATED_AT : byKey[key]))
      .filter((c) => c && c.key !== child.field);
  }, [meta, child.field]);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const open = (row) => navigate(`/m/${child.module}/${row._id}`);

  if (!meta) return <Skeleton className="m-4 h-24" />;
  const singular = meta.singular.toLowerCase();

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <span className="text-xs text-subtle tabular" aria-live="polite">
          {data ? `${data.total} ${data.total === 1 ? 'record' : 'records'}` : ''}
        </span>
        <AddChild record={record} child={child} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label={child.label}>
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className="px-4 py-2 font-medium whitespace-nowrap">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading &&
              Array.from({ length: 3 }, (_, i) => (
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
                onClick={() => open(row)}
                onKeyDown={(e) => e.key === 'Enter' && open(row)}
                className="cursor-pointer transition-colors hover:bg-surface-2/70 focus:bg-surface-2 focus:outline-none"
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn('max-w-72 px-4 py-2.5', i === 0 && 'font-medium whitespace-nowrap text-fg')}
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
        {isError && <p className="p-4 text-sm text-critical">{error.message}</p>}
        {data && data.items.length === 0 && (
          <EmptyState icon={Link2} title={`No ${meta.label.toLowerCase()} linked yet`} className="py-8">
            {child.can?.create && meta.can.create ? `Add one with "Add ${singular}".` : null}
          </EmptyState>
        )}
      </div>
      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted">
          <span className="tabular">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-1">
            <Button
              size="iconSm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              size="iconSm"
              variant="ghost"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

/** Related records of `record`: one tab per declared child relation (`label · count`), minus `hide`. */
export const RelatedRecords = ({ meta, record, hide = [] }) => {
  const { data: counts, isLoading } = useRelatedCounts(meta.name, record._id);
  const children = (counts?.children ?? []).filter((c) => !hide.includes(c.module));
  const [tab, setTab] = useState(null);
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!children.length) return null;
  const current = children.some((c) => c.module === tab) ? tab : children[0].module;
  return (
    <Card>
      <CardHeader title="Related" icon={Link2} />
      <Tabs
        value={current}
        onValueChange={setTab}
        className="pt-3"
        tabs={children.map((c) => ({
          value: c.module,
          label: `${c.label} · ${c.count}`,
        }))}
      >
        {children.map((c) => (
          <TabPanel key={c.module} value={c.module} className="-mt-4">
            {current === c.module && <RelatedTable parentMeta={meta} record={record} child={c} />}
          </TabPanel>
        ))}
      </Tabs>
    </Card>
  );
};
