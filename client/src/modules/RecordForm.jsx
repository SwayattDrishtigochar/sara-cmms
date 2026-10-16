import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSession } from '../auth/useAuth.js';
import { Button } from '../ui/core.jsx';
import { emptyValue, FieldInput, fromFormValue, isWide, toFormValue } from './FieldInput.jsx';
import { useSaveRecord } from './useModules.js';

/** Fields a user may edit here: not read-only/hidden; the plant is fixed for plant-locked users. */
const editableFields = (meta, ctx, isNew) =>
  meta.fields.filter(
    (f) =>
      !f.readOnly &&
      !f.hidden &&
      (!f.secret || isNew || f.key === 'password') &&
      !(f.key === 'plantId' && ctx?.plantLocked),
  );

/** Create (no record) or edit a record of any module, driven by its field metadata. */
export const RecordForm = ({ meta, record, onDone, onCancel }) => {
  const ctx = useSession();
  const isNew = !record;
  const fields = useMemo(() => editableFields(meta, ctx, isNew), [meta, ctx, isNew]);
  const initial = useMemo(
    () =>
      Object.fromEntries(
        fields.map((f) => [f.key, isNew ? emptyValue(f) : f.secret ? '' : toFormValue(f, record?.[f.key])]),
      ),
    [fields, record, isNew],
  );
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const save = useSaveRecord(meta.name);

  const submit = (e) => {
    e.preventDefault();
    const payload = {};
    const local = {};
    for (const f of fields) {
      const changed = JSON.stringify(values[f.key]) !== JSON.stringify(initial[f.key]);
      if (!isNew && !changed) continue;
      try {
        const v = fromFormValue(f, values[f.key]);
        if (isNew && (v === null || (Array.isArray(v) && v.length === 0))) continue;
        if (f.secret && !v) continue;
        payload[f.key] = v;
      } catch (err) {
        local[f.key] = err.message;
      }
      if (f.required && isNew && (values[f.key] === '' || values[f.key] == null)) local[f.key] = 'Required';
    }
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }
    if (!isNew && Object.keys(payload).length === 0) {
      onCancel?.();
      return;
    }
    save.mutate(
      { id: record?._id, data: payload },
      {
        onSuccess: (res) => {
          toast.success(isNew ? `${meta.singular} created` : `${meta.singular} saved`);
          onDone?.(res.item);
        },
        onError: (err) => {
          const mapped = Object.fromEntries(
            (err.details ?? []).filter((d) => d.path).map((d) => [d.path, d.message]),
          );
          setErrors(mapped);
          toast.error(err.message);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <FieldInput
            key={f.key}
            meta={f}
            value={values[f.key]}
            error={errors[f.key]}
            errors={errors}
            onChange={(v) => {
              setValues((s) => ({ ...s, [f.key]: v }));
              if (errors[f.key]) setErrors(({ [f.key]: _drop, ...rest }) => rest);
            }}
            className={isWide(f) ? 'sm:col-span-2' : ''}
          />
        ))}
      </div>
      <div className="sticky bottom-0 -mx-5 -mb-4 flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {isNew ? `Create ${meta.singular.toLowerCase()}` : 'Save changes'}
        </Button>
      </div>
    </form>
  );
};
