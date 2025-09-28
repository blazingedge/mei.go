describe('Auth API (D1 + Worker)', () => {
  it('registra y loguea (mock)', () => {
    const email = `cypress+${Date.now()}@test.local`;
    const password = '12345678';

    cy.apiRegister(email, password).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property('ok', true);
    });

    cy.apiLogin(email, password).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.have.property('token').and.to.be.a('string');
      expect(res.body).to.have.nested.property('user.email', email);
      cy.request({
        method: 'POST',
        url: `${Cypress.env('API_BASE')}/auth/register`,
        body: { email, password },
        failOnStatusCode: false   // <— clave para ver el body en 500/409
        }).then((res) => {
        cy.log('STATUS', res.status.toString());
        cy.log('BODY', JSON.stringify(res.body));
        expect([200, 409]).to.include(res.status); // permite duplicado en debug
        });


      // solo si tu worker ya setea cookie httpOnly; si no, comenta esto:
      // const setCookie = res.headers['set-cookie'];
      // expect(setCookie, 'Set-Cookie debe existir').to.exist;
    });
  });
});
