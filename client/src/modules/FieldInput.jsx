import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useSession } from '../auth/useAuth.js';
import { cn } from '../lib/format.js';
import { Button } from '../ui/core.jsx';
import { Field, Input, Select, Switch, Textarea } from '../ui/form.jsx';
import { RefSelect } from './RefSelect.jsx';

/** Date fields edited without a time (the rest use datetime-local). */
const DATE_ONLY = new Set([
  'installationDate',
  'warrantyExpiryDate',
  'warrantyExpiry',
  'purchaseDate',
  'date',
  'addedDate',
  'changedDate',
  'lastMaintenanceDate',
  'dueDate',
]);
const pad = (n) => String(n).padStart(2, '0');

export const isWide = (meta) =>
  meta.type === 'text' ||
  meta.type === 'object' ||
  meta.type === 'mixed' ||
  (meta.type === 'array' && !meta.of) ||
  meta.type === 'refs';

// ── value conversions between API shape and form state ──────────────────────

export const toFormValue = (meta, value) => {
  if (value == null)
    return meta.type === 'array' || meta.type === 'refs' || meta.type === 'tags'
      ? []
      : meta.type === 'object'
        ? {}
        : '';
  switch (meta.type) {
    case 'date': {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return DATE_ONLY.has(meta.key) ? day : `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    case 'ref':
      return typeof value === 'object' ? String(value._id) : String(value);
    case 'refs':
      return value.map((v) => (typeof v === 'object' ? String(v._id) : String(v)));
    case 'object':
      return Object.fromEntries(meta.fields.map((f) => [f.key, toFormValue(f, value[f.key])]));
    case 'array':
      if (meta.of) return value;
      return value.map((row) => ({
        ...(row._id ? { _id: String(row._id) } : {}),
        ...Object.fromEntries(meta.fields.map((f) => [f.key, toFormValue(f, row[f.key])])),
      }));
    case 'mixed':
      return JSON.stringify(value, null, 2);
    default:
      return value;
  }
};

/** Form state → API value. Empty strings become null (cleared) for the server. */
export const fromFormValue = (meta, value) => {
  switch (meta.type) {
    case 'date':
      return value ? new Date(DATE_ONLY.has(meta.key) ? `${value}T00:00` : value).toISOString() : null;
    case 'number':
      return value === '' || value == null ? null : Number(value);
    case 'string':
    case 'text':
    case 'enum':
    case 'ref':
      return value === '' || value == null ? null : typeof value === 'string' ? value.trim() : value;
    case 'object': {
      const out = {};
      for (const f of meta.fields.filter((x) => !x.readOnly)) {
        const v = fromFormValue(f, value?.[f.key]);
        if (v !== null) out[f.key] = v;
      }
      return out;
    }
    case 'array':
      if (meta.of) return value ?? [];
      return (value ?? []).map((row) => {
        const out = row._id ? { _id: row._id } : {};
        for (const f of meta.fields.filter((x) => !x.readOnly)) {
          const v = fromFormValue(f, row[f.key]);
          if (v !== null) out[f.key] = v;
        }
        return out;
      });
    case 'mixed':
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        throw new Error('is not valid JSON');
      }
    default:
      return value;
  }
};

/** Form state of a new value: the field's default; an object starts from its sub-fields' defaults. */
export const emptyValue = (meta) => {
  if (meta.type === 'object') return Object.fromEntries(meta.fields.map((f) => [f.key, emptyValue(f)]));
  if (meta.default !== undefined) return meta.type === 'date' ? '' : meta.default;
  return toFormValue(meta, undefined);
};

// ── inputs ──────────────────────────────────────────────────────────────────

const TagInput = ({ value = [], onChange, placeholder, ...aria }) => {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim().replace(/,$/, '');
    if (t && !value.includes(t)) onChange([...value, t]);
    setText('');
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 shadow-card focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
      {value.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium"
        >
          {t}
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x !== t))}
            aria-label={`Remove ${t}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        {...aria}
        className="h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-subtle"
        value={text}
        placeholder={placeholder ?? 'Type and press Enter'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
};

const RowsEditor = ({ meta, value = [], onChange, errors, path }) => {
  const editable = meta.fields.filter((f) => !f.readOnly && !f.hidden);
  const addRow = () => onChange([...value, Object.fromEntries(editable.map((f) => [f.key, emptyValue(f)]))]);
  return (
    <div className="space-y-2">
      {value.map((row, i) => (
        <div key={row._id ?? i} className="rounded-xl border border-border bg-surface-2/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-subtle">
              {meta.label} #{i + 1}
            </span>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              aria-label={`Remove row ${i + 1}`}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {editable.map((f) => (
              <FieldInput
                key={f.key}
                meta={f}
                value={row[f.key]}
                error={errors?.[`${path}.${i}.${f.key}`]}
                errors={errors}
                path={`${path}.${i}.${f.key}`}
                onChange={(v) => onChange(value.map((r, j) => (j === i ? { ...r, [f.key]: v } : r)))}
                className={isWide(f) ? 'sm:col-span-2' : ''}
              />
            ))}
          </div>
        </div>
      ))}
      <Button size="sm" icon={Plus} onClick={addRow}>
        Add {meta.label.toLowerCase().replace(/s$/, '')}
      </Button>
    </div>
  );
};

const Control = ({ meta, value, onChange, a11y, errors, path }) => {
  const ctx = useSession();
  switch (meta.type) {
    case 'text':
      return <Textarea {...a11y} value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} />;
    case 'number':
      return (
        <Input
          {...a11y}
          type="number"
          step="any"
          inputMode="decimal"
          value={value ?? ''}
          suffix={meta.unit}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'boolean':
      return <Switch id={a11y.id} checked={value} onChange={onChange} label={value ? 'Yes' : 'No'} />;
    case 'date':
      return (
        <Input
          {...a11y}
          type={DATE_ONLY.has(meta.key) ? 'date' : 'datetime-local'}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'enum':
      return (
        <Select {...a11y} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {!meta.required && <option value="">—</option>}
          {meta.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      );
    case 'ref':
      if (meta.key === 'plantId' && ctx) {
        return (
          <Select {...a11y} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">All plants</option>
            {ctx.plants.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </Select>
        );
      }
      return <RefSelect {...a11y} refModule={meta.ref} value={value} onChange={onChange} />;
    case 'refs':
      return <RefSelect {...a11y} refModule={meta.ref} value={value} onChange={onChange} multiple />;
    case 'tags':
      return <TagInput {...a11y} value={value} onChange={onChange} />;
    case 'object':
      return (
        <fieldset className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-2">
          {meta.fields
            .filter((f) => !f.readOnly && !f.hidden)
            .map((f) => (
              <FieldInput
                key={f.key}
                meta={f}
                value={value?.[f.key]}
                errors={errors}
                path={`${path}.${f.key}`}
                error={errors?.[`${path}.${f.key}`]}
                onChange={(v) => onChange({ ...value, [f.key]: v })}
                className={isWide(f) ? 'sm:col-span-2' : ''}
              />
            ))}
        </fieldset>
      );
    case 'array':
      if (meta.of?.type === 'enum') {
        const list = value ?? [];
        return (
          <div className="flex flex-wrap gap-1.5">
            {meta.of.values.map((v) => {
              const on = list.includes(v);
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? list.filter((x) => x !== v) : [...list, v])}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-xs font-medium capitalize',
                    on ? 'border-brand bg-brand-soft text-brand' : 'border-border text-muted hover:text-fg',
                  )}
                >
                  {v}
                </button>
              );
            })}
          </div>
        );
      }
      if (meta.of) return <TagInput {...a11y} value={value} onChange={onChange} />;
      return <RowsEditor meta={meta} value={value} onChange={onChange} errors={errors} path={path} />;
    case 'mixed':
      return (
        <Textarea
          {...a11y}
          className="font-mono text-xs"
          rows={6}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default: {
      const listId = meta.suggestions ? `${a11y.id}-suggestions` : undefined;
      return (
        <>
          <Input
            {...a11y}
            type={meta.secret ? 'password' : meta.key === 'email' ? 'email' : 'text'}
            autoComplete={meta.secret ? 'new-password' : undefined}
            list={listId}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
          {listId && (
            <datalist id={listId}>
              {meta.suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </>
      );
    }
  }
};

/** One labelled form field for any registry field type. `path` keys server errors. */
export const FieldInput = ({ meta, value, onChange, error, errors, path = meta.key, className }) => (
  <Field label={meta.label} required={meta.required} help={meta.help} error={error} className={className}>
    {(a11y) => (
      <Control meta={meta} value={value} onChange={onChange} a11y={a11y} errors={errors} path={path} />
    )}
  </Field>
);
