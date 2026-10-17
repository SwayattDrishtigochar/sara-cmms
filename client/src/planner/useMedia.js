import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * `[ref, narrow]`: narrow while the element is under `px` wide, so a wide table can stack into cards inside a
 * narrow column. Unmeasured (no layout, as in jsdom) counts as wide.
 */
export const useNarrow = (px) => {
  const [el, setEl] = useState(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!el) return undefined;
    const measure = () => {
      if (el.clientWidth > 0) setNarrow(el.clientWidth < px);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, px]);
  return [setEl, narrow];
};

const query = () =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)') : null;

/** True below Tailwind's `md` (tables become stacked cards); false where matchMedia is missing. */
export const useBelowMd = () => {
  const [below, setBelow] = useState(() => Boolean(query()?.matches));
  useEffect(() => {
    const mq = query();
    if (!mq?.addEventListener) return undefined;
    const onChange = (e) => setBelow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return below;
};
