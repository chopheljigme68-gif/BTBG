import request from 'supertest';
import { createApp } from '../src/app.js';

export const app = createApp();
export const PASSWORD = 'Btbg#Demo2026';

/** Sign in (completing MFA with the exposed dev code) and return a bearer token. */
export async function login(mobile: string, password = PASSWORD) {
  const res = await request(app).post('/auth/login').send({ mobile, password });
  if (res.status !== 200) throw new Error(`login ${mobile} failed: ${res.status} ${JSON.stringify(res.body)}`);
  let token: string = res.body.token;
  if (res.body.mfaRequired) {
    const mfa = await request(app).post('/auth/mfa/verify').set('authorization', `Bearer ${token}`).send({ code: res.body.devCode });
    if (mfa.status !== 200) throw new Error(`mfa ${mobile} failed: ${mfa.status} ${JSON.stringify(mfa.body)}`);
    token = mfa.body.token ?? token;
  }
  return token;
}

export const as = (token: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${token}`).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${token}`).send(body),
});
