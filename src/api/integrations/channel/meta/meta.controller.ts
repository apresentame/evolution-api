import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    if (data.object !== 'whatsapp_business_account') {
      return {
        status: 'success',
      };
    }

    // Meta batches events: a single webhook call can carry several entries, each with several changes
    // (history sync, for instance, arrives in chunks). Previously only entry[0].changes[0] was read and
    // the whole payload was forwarded, so entry[0] was processed once per entry and the rest was lost.
    //
    // The whole walk runs detached — Meta retries the delivery when the request takes too long, and the
    // downstream chain (webhook fan-out with its own retries) can take minutes — but the changes inside
    // it are handled one at a time. Processing them in parallel would race on contact/chat creation and
    // could persist messages out of order, or a status before its own message.
    const changes = (data.entry ?? []).flatMap((entry: any) => entry?.changes ?? []);

    void (async () => {
      for (const change of changes) {
        try {
          await this.handleChange(change);
        } catch (error) {
          this.logger.error(error);
        }
      }
    })();

    return {
      status: 'success',
    };
  }

  private async handleChange(change: any) {
    if (change?.field === 'message_template_status_update') {
      return this.handleTemplateStatus(change);
    }

    const numberId = change?.value?.metadata?.phone_number_id;

    if (!numberId) {
      this.logger.error(`WebhookService -> receiveWebhookMeta -> numberId not found (field=${change?.field})`);
      return;
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { number: numberId },
    });

    if (!instance) {
      // Logging the number matters: a history chunk for an unknown number is lost for good, and the id
      // is what tells whether the connection was removed or the number never matched.
      this.logger.error(
        `WebhookService -> receiveWebhookMeta -> instance not found for number ${numberId} (field=${change?.field})`,
      );
      return;
    }

    await this.waMonitor.waInstances[instance.name].connectToWhatsapp({ entry: [{ changes: [change] }] }, change);
  }

  private async handleTemplateStatus(change: any) {
    const template = await this.prismaRepository.template.findFirst({
      where: { templateId: `${change.value?.message_template_id}` },
    });

    if (!template) {
      this.logger.error('WebhookService -> receiveWebhookMeta -> template not found');
      return;
    }

    const { webhookUrl } = template;

    await axios.post(webhookUrl, change.value, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}
