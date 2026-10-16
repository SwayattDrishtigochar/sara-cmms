import '@fontsource-variable/inter';
import './index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { setToken, setUnauthorizedHandler } from './api/client.js';
import { router } from './routes.jsx';
import { TooltipProvider } from './ui/overlay.jsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => err?.status >= 500 && count < 2,
    },
  },
});

// Any 401 with a token means the session ended: clear it and go to sign-in.
setUnauthorizedHandler(() => {
  setToken(null);
  queryClient.clear();
  if (!location.pathname.startsWith('/login')) router.navigate('/login', { replace: true });
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster position="top-right" richColors closeButton theme="system" />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
