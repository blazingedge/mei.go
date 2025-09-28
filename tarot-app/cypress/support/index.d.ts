declare namespace Cypress {
  interface Chainable {
    apiRegister(email: string, password: string): Chainable<Cypress.Response<any>>;
    apiLogin(email: string, password: string): Chainable<Cypress.Response<any>>;
  }
}