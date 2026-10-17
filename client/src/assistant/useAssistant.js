import { create } from 'zustand';

/**
 * The global assistant drawer. Other pages call `useAssistant.getState().open({ text, context, send })`:
 * `text` pre-fills the composer, `send: true` sends it at once, `context` ({ page, recordRef }) overrides
 * the one derived from the current route. The drawer keeps its conversation between openings.
 */
export const useAssistant = create((set) => ({
  isOpen: false,
  text: '',
  context: null,
  pendingSend: null, // text to send once the drawer is open
  nonce: 0,
  conversationId: null,
  open: ({ text, context, send } = {}) =>
    set((s) => {
      const now = Boolean(send && text?.trim());
      return {
        isOpen: true,
        text: now ? '' : (text ?? ''),
        context: context ?? null,
        pendingSend: now ? text.trim() : null,
        nonce: s.nonce + 1,
      };
    }),
  close: () => set({ isOpen: false, context: null }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen, ...(s.isOpen ? { context: null } : {}) })),
  setConversationId: (conversationId) => set({ conversationId }),
}));

/**
 * Opens an app page SARA chose (open_page): app-relative paths only, through the router so the page keeps
 * its state. The drawer closes so the page is visible; the voice panel stays (it docks itself).
 */
export const goTo = (url) => {
  const path = String(url ?? '');
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  useAssistant.setState({ isOpen: false, context: null });
  import('../routes.jsx').then(({ router }) => router.navigate(path));
  return true;
};

/** Chat context of a route: Machine 360 and record pages point SARA at that record. */
export const contextFromPath = (pathname) => {
  const machine = /^\/machines\/([^/]+)/.exec(pathname);
  if (machine) return { page: 'machine', recordRef: { module: 'assets', id: machine[1] } };
  const record = /^\/m\/([^/]+)\/([^/]+)/.exec(pathname);
  if (record) return { page: 'record', recordRef: { module: record[1], id: record[2] } };
  const list = /^\/m\/([^/]+)\/?$/.exec(pathname);
  if (list) return { page: `${list[1]} list` };
  const page = pathname.split('/').filter(Boolean)[0];
  return page ? { page } : { page: 'home' };
};
