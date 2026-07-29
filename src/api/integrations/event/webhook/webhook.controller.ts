import { EventDto } from '@api/integrations/event/event.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { wa } from '@api/types/wa.types';
import { configService, Log, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
// import { BadRequestException } from '@exceptions';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

export class WebhookController extends EventController implements EventControllerInterface {
  private readonly logger = new Logger('WebhookController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, true, 'webhook');
  }

  override async set(instanceName: string, data: EventDto): Promise<wa.LocalWebHook> {
    // if (!/^(https?:\/\/)/.test(data.webhook.url)) {
    //   throw new BadRequestException('Invalid "url" property');
    // }

    if (!data.webhook?.enabled) {
      data.webhook.events = [];
    } else {
      if (0 === data.webhook.events.length) {
        data.webhook.events = EventController.events;
      }
    }

    return this.prisma.webhook.upsert({
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
      create: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
    });
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    local,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('webhook')) {
      return;
    }

    const instance = (await this.get(instanceName)) as wa.LocalWebHook;

    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const webhookLocal = instance?.events;
    const webhookHeaders = { ...((instance?.headers as Record<string, string>) || {}) };

    if (webhookHeaders && 'jwt_key' in webhookHeaders) {
      const jwtKey = webhookHeaders['jwt_key'];
      const jwtToken = this.generateJwtToken(jwtKey);
      webhookHeaders['Authorization'] = `Bearer ${jwtToken}`;

      delete webhookHeaders['jwt_key'];
    }

    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const transformedWe = we.replace(/_/gm, '-').toLowerCase();
    const enabledLog = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');
    const regex = /^(https?:\/\/)/;

    const webhookData = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      destination: instance?.url || `${webhookConfig.GLOBAL.URL}/${transformedWe}`,
      date_time: dateTime,
      sender,
      server_url: serverUrl,
      apikey: apiKey,
    };

    if (local && instance?.enabled) {
      if (Array.isArray(webhookLocal) && webhookLocal.includes(we)) {
        const urls = (instance?.url || '')
          .split(',')
          .map((u) => u.trim())
          .filter((u) => regex.test(u));

        const enhancedHeaders = {
          ...webhookHeaders,
          'Content-Type': 'application/json',
          'X-Instance-ID': this.monitor.waInstances[instanceName].instanceId,
          'X-Instance-Name': instanceName,
          'X-Event-Type': event,
          'X-Timestamp': Date.now().toString(),
          'User-Agent': 'EvolutionAPI-Webhook/2.3.7',
        };

        const resolvedUrls = urls.map((u, i) => (i === 0 && instance?.webhookByEvents ? `${u}/${transformedWe}` : u));

        if (enabledLog) {
          this.logger.log({
            local: `${origin}.sendData-Webhook`,
            urls: resolvedUrls,
            ...webhookData,
          });
        }

        try {
          await this.retryWebhookRequest(
            webhookData,
            `${origin}.sendData-Webhook`,
            resolvedUrls,
            enhancedHeaders as Record<string, string>,
            serverUrl,
          );
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook`,
            message: `Todas as tentativas falharam em todas as URLs: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            urls: resolvedUrls,
            server_url: serverUrl,
          });
        }
      }
    }

    if (webhookConfig.GLOBAL?.ENABLED) {
      if (webhookConfig.EVENTS[we]) {
        let globalURL = webhookConfig.GLOBAL.URL;

        if (webhookConfig.GLOBAL.WEBHOOK_BY_EVENTS) {
          globalURL = `${globalURL}/${transformedWe}`;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook-Global`,
            url: globalURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (regex.test(globalURL)) {
            await this.retryWebhookRequest(
              webhookData,
              `${origin}.sendData-Webhook-Global`,
              [globalURL],
              {},
              serverUrl,
            );
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook-Global`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: globalURL,
            server_url: serverUrl,
          });
        }
      }
    }
  }

  private async retryWebhookRequest(
    webhookData: any,
    origin: string,
    urls: string[],
    headers: Record<string, string>,
    serverUrl: string,
    maxRetries?: number,
    delaySeconds?: number,
  ): Promise<void> {
    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const maxRetryAttempts = maxRetries ?? webhookConfig.RETRY?.MAX_ATTEMPTS ?? 10;
    const initialDelay = delaySeconds ?? webhookConfig.RETRY?.INITIAL_DELAY_SECONDS ?? 5;
    const useExponentialBackoff = webhookConfig.RETRY?.USE_EXPONENTIAL_BACKOFF ?? true;
    const maxDelay = webhookConfig.RETRY?.MAX_DELAY_SECONDS ?? 300;
    const jitterFactor = webhookConfig.RETRY?.JITTER_FACTOR ?? 0.2;
    const nonRetryableStatusCodes = webhookConfig.RETRY?.NON_RETRYABLE_STATUS_CODES ?? [400, 401, 403, 404, 422];
    const timeout = webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000;

    let pendingUrls = [...urls];
    let attempts = 0;

    while (pendingUrls.length > 0 && attempts < maxRetryAttempts) {
      if (attempts > 0) {
        let nextDelay = initialDelay;
        if (useExponentialBackoff) {
          nextDelay = Math.min(initialDelay * Math.pow(2, attempts - 1), maxDelay);
          const jitter = nextDelay * jitterFactor * (Math.random() * 2 - 1);
          nextDelay = Math.max(initialDelay, nextDelay + jitter);
        }

        this.logger.log({
          local: origin,
          message: `Aguardando ${nextDelay.toFixed(1)}s antes da tentativa ${attempts + 1}/${maxRetryAttempts} (${pendingUrls.length} URL(s) pendente(s))`,
          pendingUrls,
        });

        await new Promise((resolve) => setTimeout(resolve, nextDelay * 1000));
      }

      const results = await Promise.allSettled(
        pendingUrls.map((url) => axios.post(url, webhookData, { headers, timeout })),
      );

      const stillPending: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const url = pendingUrls[i];

        if (result.status === 'fulfilled') {
          if (attempts > 0) {
            this.logger.log({
              local: origin,
              message: `Sucesso no envio após ${attempts + 1} tentativas`,
              url,
            });
          }
          continue;
        }

        const error = result.reason;
        const isTimeout = error.code === 'ECONNABORTED';

        if (error?.response?.status && nonRetryableStatusCodes.includes(error.response.status)) {
          this.logger.error({
            local: origin,
            message: `Erro não recuperável (${error.response.status}): ${error?.message}. Cancelando retentativas para esta URL.`,
            statusCode: error?.response?.status,
            url,
            server_url: serverUrl,
          });
          continue;
        }

        this.logger.error({
          local: origin,
          message: `Tentativa ${attempts + 1}/${maxRetryAttempts} falhou para ${url}: ${isTimeout ? 'Timeout da requisição' : error?.message}`,
          hostName: error?.hostname,
          syscall: error?.syscall,
          code: error?.code,
          isTimeout,
          statusCode: error?.response?.status,
          error: error?.errno,
          stack: error?.stack,
          name: error?.name,
          url,
          server_url: serverUrl,
        });

        stillPending.push(url);
      }

      attempts++;
      pendingUrls = stillPending;
    }

    if (pendingUrls.length > 0) {
      throw new Error(
        `Falha ao entregar para ${pendingUrls.length} URL(s) após ${attempts} tentativas: ${pendingUrls.join(', ')}`,
      );
    }
  }

  private generateJwtToken(authToken: string): string {
    try {
      const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600, // 10 min expiration
        app: 'evolution',
        action: 'webhook',
      };

      const token = jwt.sign(payload, authToken, { algorithm: 'HS256' });
      return token;
    } catch (error) {
      this.logger.error({
        local: 'WebhookController.generateJwtToken',
        message: `JWT generation failed: ${error?.message}`,
      });
      throw error;
    }
  }
}
