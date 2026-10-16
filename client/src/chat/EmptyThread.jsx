import { Activity, ChartLine, Package, ShieldCheck, Wrench, Zap } from 'lucide-react';
import { useSession } from '../auth/useAuth.js';
import { getFormatPrefs } from '../lib/format.js';
import { useRecords } from '../modules/useModules.js';

/** First asset whose type matches `re`, by name. */
const pick = (assets, re, fallback) =>
  assets.find((a) => re.test(a.typeOfAsset ?? a.name ?? ''))?.name ?? fallback;

/** Example questions for this plant: real machine names when the asset list is there. */
export const examplePrompts = (assets = []) => {
  const imm = pick(assets, /inject|imm/i, 'IMM 3');
  const compressor = pick(assets, /compress/i, 'Compressor 1');
  return [
    { icon: Activity, topic: 'Machine health', text: 'Which machines need attention right now, and why?' },
    { icon: ChartLine, topic: 'Live trends', text: `Show ${imm} vibration for the last 2 hours` },
    {
      icon: Wrench,
      topic: 'Maintenance',
      text: `Create a work order for ${imm}: coolant leak, high priority, due tomorrow`,
    },
    { icon: Zap, topic: 'Energy & cost', text: `Energy use of ${compressor} today vs yesterday` },
    {
      icon: ShieldCheck,
      topic: 'Work orders',
      text: 'How many open work orders do we have, grouped by priority?',
    },
    {
      icon: Package,
      topic: 'Stock',
      text: 'Which spare parts are below minimum stock and who supplies them?',
    },
  ];
};

const greeting = () => {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hour12: false,
      timeZone: getFormatPrefs().timeZone,
    }).format(new Date()),
  );
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
};

/** A new conversation: greeting, what SARA can do here, and example prompts that send on click. */
export const EmptyThread = ({ onPick, disabled }) => {
  const ctx = useSession();
  const { data } = useRecords('assets', { limit: 100, sort: 'name' });
  const prompts = examplePrompts(data?.items);
  const first = ctx?.user?.name?.split(' ')[0];
  return (
    <div className="flex flex-col items-center py-8 text-center sm:py-14 animate-fade-in">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-[linear-gradient(135deg,var(--brand),var(--ai))] text-white shadow-pop">
        <Activity className="size-6" aria-hidden />
      </span>
      <h2 className="text-xl font-semibold tracking-tight text-fg">
        {greeting()}
        {first ? `, ${first}` : ''}
      </h2>
      <p className="mt-1.5 max-w-md text-sm text-muted">
        Ask SARA about {ctx?.company?.name ?? 'your plant'}: machines, maintenance, production, stock and
        costs. It reads your live data, draws charts and tables, and changes records only after you confirm.
      </p>
      <ul className="mt-7 grid w-full gap-2 text-left sm:grid-cols-2" aria-label="Example questions">
        {prompts.map((p) => (
          <li key={p.text} className="[&:nth-child(n+5)]:hidden sm:[&:nth-child(n+5)]:block">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p.text)}
              className="group flex h-full w-full items-start gap-3 rounded-xl text-left border border-border bg-surface px-3.5 py-3 shadow-card transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px hover:border-brand/40 hover:bg-surface-2/60 disabled:opacity-50 motion-reduce:hover:translate-y-0"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted transition-colors duration-150 group-hover:bg-brand-soft group-hover:text-brand">
                <p.icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-medium text-subtle">{p.topic}</span>
                <span className="block text-sm leading-snug text-fg">{p.text}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
