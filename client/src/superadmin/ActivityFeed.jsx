import { Pause, Play, UsersRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { formatDateTime } from '../lib/format.js';
import { Avatar, Button, Card, EmptyState, Skeleton } from '../ui/core.jsx';
import { QueryError, Section } from './parts.jsx';
import { ago, targetLink } from './simUtils.js';
import { useActivity } from './useSim.js';

const Row = ({ item, now }) => {
  const link = targetLink(item.target);
  const name = item.actor?.name || 'Someone';
  return (
    <li className="flex gap-3 px-4 py-3">
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted">
          <span className="font-medium text-fg">{name}</span>
          {item.actor?.title && ` · ${item.actor.title}`}
        </p>
        <p className="mt-0.5 text-sm text-fg">{item.summary}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
          <time dateTime={item.at} title={formatDateTime(item.at)} className="tabular">
            {ago(item.at, now)}
          </time>
          {link && (
            <Link to={link} className="font-medium text-brand hover:underline">
              {item.target.code ? `Open ${item.target.code}` : 'Open the record'}
            </Link>
          )}
        </p>
      </div>
    </li>
  );
};

/** Section (e): what the simulated people did, newest first; refreshes every 3 s and pauses while you scroll. */
export const ActivityFeed = ({ peopleOff, now }) => {
  const [paused, setPaused] = useState(false);
  const listRef = useRef(null);
  const query = useActivity(paused);
  const items = query.data;
  const resume = () => {
    listRef.current?.scrollTo({ top: 0 });
    setPaused(false);
    query.refetch();
  };

  return (
    <Section
      id="sim-activity"
      icon={UsersRound}
      title="Live activity"
      description="Every action the simulated people take, as they take it."
      actions={
        paused ? (
          <Button size="sm" icon={Play} onClick={resume}>
            Resume
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon={Pause} onClick={() => setPaused(true)}>
            Pause
          </Button>
        )
      }
    >
      <Card className="overflow-hidden">
        <p className="border-b border-border px-4 py-2 text-xs text-muted" role="status">
          {paused ? 'Paused while you read. Resume to jump back to the newest.' : 'Updates every 3 seconds.'}
        </p>
        {query.isError && !items ? (
          <QueryError what="the activity" error={query.error} onRetry={query.refetch} />
        ) : !items ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={UsersRound} title="Nothing yet">
            {peopleOff
              ? 'Simulated people are switched off under Controls.'
              : 'Actions show up here once the simulator runs and someone is on shift.'}
          </EmptyState>
        ) : (
          // Scrolling down pauses the refresh, so rows don't move while you read them.
          <ol
            ref={listRef}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1)
            tabIndex={0}
            aria-label="Recent activity"
            onScroll={(e) => {
              if (!paused && e.currentTarget.scrollTop > 8) setPaused(true);
            }}
            className="max-h-128 divide-y divide-border overflow-y-auto scrollbar-thin focus-visible:outline-2 focus-visible:outline-ring"
          >
            {items.map((item) => (
              <Row key={item.id} item={item} now={now} />
            ))}
          </ol>
        )}
      </Card>
    </Section>
  );
};
