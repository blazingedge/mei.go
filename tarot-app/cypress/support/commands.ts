/// <reference types="cypress" />

const api = () => Cypress.env('API_BASE') as string;

Cypress.Commands.add('apiRegister', (email: string, password: string) => {
  const api = Cypress.env('API_BASE') as string | undefined;
  if (!api) {
    return cy.wrap({ status: 200, body: { ok: true, email } }, { log: false });
  }
  return cy.request('POST', `${api}/auth/register`, { email, password });
});

Cypress.Commands.add('apiLogin', (email: string, password: string) => {
  const api = Cypress.env('API_BASE') as string | undefined;
  if (!api) {
    return cy.wrap({ status: 200, body: { token: 'fake-token', user: { email } } }, { log: false });
  }
  return cy.request('POST', `${api}/auth/login`, { email, password });
});


