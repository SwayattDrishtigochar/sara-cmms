import { ArrowLeft, Bot, MessageSquare, Pencil, Trash2, User } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { cn, formatDateTime, formatRelative, refLabel } from '../lib/format.js';
import { moduleIcon } from '../lib/icons.js';
import { Avatar, Button, Card, CardHeader, EmptyState, Skeleton } from '../ui/core.jsx';
import { Field, Textarea } from '../ui/form.jsx';
import { Dialog, Sheet } from '../ui/overlay.jsx';
import { emptyValue, FieldInput, fromFormValue, isWide } from './FieldInput.jsx';
import { FieldValue } from './FieldValue.jsx';
import { RecordForm } from './RecordForm.jsx';
import { useDeleteRecord, useModuleMeta, useRecord, useRecordAction } from './useModules.js';

const SIDE_KEYS = new Set(['plantId', 'comments']);

const ActionDialog = ({ meta, action, record, onClose }) => {
  const [values, setValues] = useState(() =>
    Object.fromEntries(action.fields.map((f) => [f.key, emptyValue(f)])),
  );
  const run = useRecordAction(meta.name);
  const submit = () => {
    const input = {};
    for (const f of action.fields) {
      const v = fromFormValue(f, values[f.key]);
      if (v !== null && v !== '') input[f.key] = v;
    }
    run.mutate(
      { id: record._id, action: action.key, input },
      {
        onSuccess: () => {
          toast.success(`${action.label} done`);
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={action.label}
      description={refLabel(record)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} onClick={submit}>
            {action.label}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {action.fields.map((f) => (
          <FieldInput
            key={f.key}
            meta={f}
            value={values[f.key]}
            onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
          />
        ))}
      </div>
    </Dialog>
  );
};

const Comments = ({ comments }) => (
  <Card>
    <CardHeader title="Activity" icon={MessageSquare} subtitle={`${comments.length} entries`} />
    <ol className="max-h-[480px] space-y-4 overflow-y-auto p-4 scrollbar-thin">
      {[...comments].reverse().map((c, i) => {
        const who = c.user && typeof c.user === 'object' ? refLabel(c.user) : 'SARA';
        return (
          <li key={c._id ?? i} className="flex gap-3">
            {c.type === 'automate' ? (
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
                <Bot className="size-3.5" aria-hidden />
              </span>
            ) : (
              <Avatar name={who} size="sm" />
            )}
            <div className="min-w-0">
              <p className={cn('text-sm', c.type === 'automate' ? 'text-muted' : 'text-fg')}>{c.comment}</p>
              <p className="mt-0.5 text-[11px] text-subtle">
                {who} · {formatRelative(c.createdAt)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  </Card>
);

export const RecordPage = () => {
  const { module: name, id } = useParams();
  const navigate = useNavigate();
  const { data: meta } = useModuleMeta(name);
  const { data: record, isLoading, isError, error } = useRecord(name, id);
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');
  const del = useDeleteRecord(name);

  const sections = useMemo(() => {
    if (!meta) return { scalar: [], wide: [] };
    const shownInHeader = new Set([meta.codeField, meta.titleField]);
    const visible = meta.fields.filter(
      (f) => !f.hidden && !f.secret && !SIDE_KEYS.has(f.key) && !shownInHeader.has(f.key),
    );
    return { scalar: visible.filter((f) => !isWide(f)), wide: visible.filter((f) => isWide(f)) };
  }, [meta]);

  if (isLoading || !meta) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-6 sm:px-6">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError) return <EmptyState title="Can't open this record">{error.message}</EmptyState>;

  const Icon = moduleIcon(meta.icon);
  const code = meta.codeField ? record[meta.codeField] : null;
  const title = meta.name === 'users' ? refLabel(record) : (record[meta.titleField] ?? refLabel(record));
  const badges = meta.fields.filter((f) => f.type === 'enum' && meta.list.includes(f.key) && record[f.key]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <Link
        to={`/m/${name}`}
        className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> {meta.label}
      </Link>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-surface text-brand shadow-card">
            <Icon className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            {code && <p className="font-mono text-xs text-subtle">{code}</p>}
            <h1 className="text-xl font-semibold tracking-tight text-fg">
              {typeof title === 'object' ? refLabel(title) : title}
            </h1>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {badges.map((f) => (
                <FieldValue key={f.key} meta={f} value={record[f.key]} />
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {meta.actions.map((a) => (
            <Button key={a.key} onClick={() => setAction(a)} disabled={!meta.can.update}>
              {a.label}
            </Button>
          ))}
          {meta.can.update && (
            <Button icon={Pencil} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {meta.can.delete && (
            <Button
              variant="ghost"
              icon={Trash2}
              onClick={() => setDeleting(true)}
              aria-label="Delete"
              className="text-critical hover:text-critical"
            />
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          {sections.scalar.length > 0 && (
            <Card>
              <CardHeader title="Details" />
              <dl className="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
                {sections.scalar.map((f) => (
                  <div key={f.key} className="min-w-0">
                    <dt className="text-xs font-medium text-subtle">{f.label}</dt>
                    <dd className="mt-1 text-sm text-fg">
                      <FieldValue meta={f} value={record[f.key]} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
          {sections.wide
            .filter((f) => record[f.key] != null && !(Array.isArray(record[f.key]) && !record[f.key].length))
            .map((f) => (
              <Card key={f.key}>
                <CardHeader title={f.label} />
                <div className="p-4">
                  <FieldValue meta={f} value={record[f.key]} />
                </div>
              </Card>
            ))}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Record" />
            <dl className="space-y-3 p-4 text-sm">
              {meta.plantScoped && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Plant</dt>
                  <dd className="text-right">{record.plantId ? refLabel(record.plantId) : 'All plants'}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Created</dt>
                <dd className="text-right tabular">{formatDateTime(record.createdAt)}</dd>
              </div>
              {record.createdBy && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">By</dt>
                  <dd className="flex items-center gap-1.5 text-right">
                    <User className="size-3.5 text-subtle" /> {refLabel(record.createdBy)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Updated</dt>
                <dd className="text-right">{formatRelative(record.updatedAt)}</dd>
              </div>
            </dl>
          </Card>
          {Array.isArray(record.comments) && record.comments.length > 0 && (
            <Comments comments={record.comments} />
          )}
        </div>
      </div>

      <Sheet
        open={editing}
        onOpenChange={setEditing}
        title={`Edit ${meta.singular.toLowerCase()}`}
        width="max-w-2xl"
      >
        {editing && (
          <RecordForm
            meta={meta}
            record={record}
            onCancel={() => setEditing(false)}
            onDone={() => setEditing(false)}
          />
        )}
      </Sheet>

      {action && <ActionDialog meta={meta} action={action} record={record} onClose={() => setAction(null)} />}

      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${meta.singular.toLowerCase()}?`}
        description={`${code ? `${code} · ` : ''}${typeof title === 'string' ? title : ''} will be removed from lists. It stays in the history.`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                del.mutate(
                  { id: record._id, reason: reason || undefined },
                  {
                    onSuccess: () => {
                      toast.success(`${meta.singular} deleted`);
                      navigate(`/m/${name}`);
                    },
                    onError: (err) => toast.error(err.message),
                  },
                )
              }
            >
              Delete
            </Button>
          </>
        }
      >
        <Field label="Reason (optional)">
          {(a11y) => (
            <Textarea {...a11y} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          )}
        </Field>
      </Dialog>
    </div>
  );
};
