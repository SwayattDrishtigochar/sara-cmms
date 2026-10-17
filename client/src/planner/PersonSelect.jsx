import { Select } from '../ui/form.jsx';
import { usePeople } from './usePlanning.js';

const busyText = (p) =>
  (p.busy ?? [])
    .map((b) => b.code)
    .filter(Boolean)
    .join(', ');

/**
 * Native select of one person of `department` for `window` (`{ from, to }` ISO): free people first (a skill
 * match is tagged "fits"), busy ones disabled with what books them, off-shift ones under a divider.
 * `label` names the current `value` while the list loads; `exclude` hides userIds.
 */
export const PersonSelect = ({
  department,
  window: win,
  skills,
  value,
  onChange,
  exclude = [],
  label,
  plantId,
  disabled,
  ...props
}) => {
  const query = usePeople({
    department,
    from: win?.from,
    to: win?.to,
    ...(skills?.length ? { skills: skills.join(',') } : {}),
    ...(plantId ? { plantId } : {}),
  });
  const people = (query.data?.people ?? []).filter((p) => !exclude.includes(p.userId));
  const free = people.filter((p) => p.free);
  const busy = people.filter((p) => !p.free && (p.busy ?? []).length);
  const off = people.filter((p) => !p.free && !(p.busy ?? []).length);
  const known = people.some((p) => p.userId === value);
  return (
    <Select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      {...props}
    >
      <option value="">{query.isLoading ? 'Loading people…' : 'Nobody'}</option>
      {value && !known && <option value={value}>{label ?? 'Assigned'}</option>}
      {free.length > 0 && (
        <optgroup label="Free">
          {free.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
              {p.shift ? ` · ${p.shift}` : ''}
              {p.skillMatch ? ' · fits' : ''}
            </option>
          ))}
        </optgroup>
      )}
      {busy.length > 0 && (
        <optgroup label="Busy">
          {busy.map((p) => (
            <option key={p.userId} value={p.userId} disabled={p.userId !== value}>
              {p.name} · busy: {busyText(p)}
            </option>
          ))}
        </optgroup>
      )}
      {off.length > 0 && (
        <optgroup label="Off shift">
          {off.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
              {p.shift ? ` · ${p.shift}` : ''}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
};
