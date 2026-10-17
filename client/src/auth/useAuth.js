import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { api, getToken, setToken } from '../api/client.js';
import { setFormatPrefs } from '../lib/format.js';

/** The signed-in user and their company context (null when signed out). */
export const useMe = () => {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api('/auth/me'),
    enabled: Boolean(getToken()),
    staleTime: 5 * 60_000,
    retry: false,
  });
  useEffect(() => {
    if (query.data?.context) setFormatPrefs(query.data.context.company);
  }, [query.data]);
  return query;
};

/** Shortcut for components inside the authenticated shell. */
export const useSession = () => {
  const { data } = useMe();
  return data?.context ?? null;
};

const useSignIn = (path) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api(path, { method: 'POST', body }),
    onSuccess: (data) => {
      setToken(data.token);
      setFormatPrefs(data.context.company);
      qc.setQueryData(['me'], { user: data.user, context: data.context });
    },
  });
};

export const useLogin = () => useSignIn('/auth/login');

/** Demo mode: signs in as a listed demo person with { email } only. */
export const useDemoLogin = () => useSignIn('/auth/demo-login');

/** Demo mode's account list; [] while loading or when demo mode is off (the route answers 404). */
export const useDemoAccounts = () =>
  useQuery({
    queryKey: ['demo-accounts'],
    queryFn: () => api('/auth/demo-accounts'),
    retry: false,
    staleTime: 5 * 60_000,
    select: (data) => data?.accounts ?? [],
  });

export const useLogout = () => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // already signed out server-side
    }
    setToken(null);
    qc.clear();
    navigate('/login', { replace: true });
  }, [qc, navigate]);
};

/** Can the current user create/update/delete in a module? */
export const useCan = (moduleName) => {
  const ctx = useSession();
  return ctx?.can?.[moduleName] ?? { create: false, update: false, delete: false };
};
