import { passkeyController } from '@api/server.module';
import { Router } from 'express';

export class PasskeyRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router.get('/passkey-ceremony/:token', (req, res) => {
      const { status, body } = passkeyController.getCeremony(req.params.token);
      res.status(status).json(body);
    });

    this.router.post('/passkey-ceremony/:token/response', async (req, res) => {
      const { status, body } = await passkeyController.submitResponse(req.params.token, req.body);
      res.status(status).json(body);
    });

    this.router.post('/passkey-ceremony/:token/confirm', async (req, res) => {
      const { status, body } = await passkeyController.confirm(req.params.token);
      res.status(status).json(body);
    });
  }
}
