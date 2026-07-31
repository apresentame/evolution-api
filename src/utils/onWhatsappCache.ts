import { prismaRepository } from '@api/server.module';
import { configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';

import { getAvailableNumbers } from './getAvailableNumbers';

const logger = new Logger('OnWhatsappCache');

interface ISaveOnWhatsappCacheParams {
  remoteJid: string;
  remoteJidAlt?: string;
  lid?: 'lid' | undefined;
}

function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  return jid.startsWith('+') ? jid.slice(1) : jid;
}

export async function saveOnWhatsappCache(data: ISaveOnWhatsappCacheParams[]) {
  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    return;
  }

  // Processa todos os itens em paralelo para melhor performance
  const processingPromises = data.map(async (item) => {
    try {
      const remoteJid = normalizeJid(item.remoteJid);
      if (!remoteJid) {
        logger.warn('[saveOnWhatsappCache] Item skipped, missing remoteJid.');
        return;
      }

      const altJidNormalized = normalizeJid(item.remoteJidAlt);
      const lidAltJid = altJidNormalized && altJidNormalized.includes('@lid') ? altJidNormalized : null;

      const baseJids = [remoteJid]; // Garante que o remoteJid esteja na lista inicial
      if (lidAltJid) {
        baseJids.push(lidAltJid);
      }

      const expandedJids = baseJids.flatMap((jid) => getAvailableNumbers(jid));

      // 1. Busca entrada por jidOptions e também remoteJid
      // Às vezes acontece do remoteJid atual NÃO ESTAR no jidOptions ainda, ocasionando o erro:
      // 'Unique constraint failed on the fields: (`remoteJid`)'
      // Isso acontece principalmente em grupos que possuem o número do criador no ID (ex.: '559911223345-1234567890@g.us')
      const existingRecord = await prismaRepository.isOnWhatsapp.findFirst({
        where: {
          OR: [
            ...expandedJids.map((jid) => ({ jidOptions: { contains: jid } })),
            { remoteJid: remoteJid }, // TODO: Descobrir o motivo que causa o remoteJid não estar (às vezes) incluso na lista de jidOptions
          ],
        },
      });

      logger.verbose(
        `[saveOnWhatsappCache] Register exists for [${expandedJids.join(',')}]? => ${existingRecord ? existingRecord.remoteJid : 'Not found'}`,
      );

      // 2. Unifica todos os JIDs usando um Set para garantir valores únicos
      const finalJidOptions = new Set(expandedJids);

      if (lidAltJid) {
        finalJidOptions.add(lidAltJid);
      }

      if (existingRecord?.jidOptions) {
        existingRecord.jidOptions.split(',').forEach((jid) => finalJidOptions.add(jid));
      }

      // 3. Prepara o payload final
      // Ordena os JIDs para garantir consistência na string final
      const sortedJidOptions = [...finalJidOptions].sort();
      const newJidOptionsString = sortedJidOptions.join(',');
      const newLid = item.lid === 'lid' || item.remoteJid?.includes('@lid') ? 'lid' : null;

      const dataPayload = {
        remoteJid: remoteJid,
        jidOptions: newJidOptionsString,
        lid: newLid,
      };

      // 4. Decide entre Criar ou Atualizar
      if (existingRecord) {
        // Compara a string de JIDs ordenada existente com a nova
        const existingJidOptionsString = existingRecord.jidOptions
          ? existingRecord.jidOptions.split(',').sort().join(',')
          : '';

        const isDataSame =
          existingRecord.remoteJid === dataPayload.remoteJid &&
          existingJidOptionsString === dataPayload.jidOptions &&
          existingRecord.lid === dataPayload.lid;

        if (isDataSame) {
          logger.verbose(`[saveOnWhatsappCache] Data for ${remoteJid} is already up-to-date. Skipping update.`);
          return; // Pula para o próximo item
        }

        // Os dados são diferentes, então atualiza
        logger.verbose(
          `[saveOnWhatsappCache] Register exists, updating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        await prismaRepository.isOnWhatsapp.update({
          where: { id: existingRecord.id },
          data: dataPayload,
        });
      } else {
        // Cria nova entrada
        logger.verbose(
          `[saveOnWhatsappCache] Register does not exist, creating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        try {
          await prismaRepository.isOnWhatsapp.create({
            data: dataPayload,
          });
        } catch (error: any) {
          // Check for unique constraint violation (Prisma error code P2002)
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002' &&
            (error.meta?.target as string[])?.includes('remoteJid')
          ) {
            logger.verbose(
              `[saveOnWhatsappCache] Race condition detected for ${remoteJid}, updating existing record instead.`,
            );
            await prismaRepository.isOnWhatsapp.update({
              where: { remoteJid: remoteJid },
              data: dataPayload,
            });
          } else {
            throw error;
          }
        }
      }
    } catch (e) {
      // Loga o erro mas não para a execução dos outros promises
      logger.error(`[saveOnWhatsappCache] Error processing item for ${item.remoteJid}: `);
      logger.error(e);
    }
  });

  // Espera todas as operações paralelas terminarem
  await Promise.allSettled(processingPromises);
}

export async function getOnWhatsappCache(remoteJids: string[]) {
  let results: {
    remoteJid: string;
    number: string;
    jidOptions: string[];
    lid?: string;
  }[] = [];

  if (configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    const remoteJidsWithoutPlus = remoteJids.map((remoteJid) => getAvailableNumbers(remoteJid)).flat();

    const onWhatsappCache = await prismaRepository.isOnWhatsapp.findMany({
      where: {
        OR: remoteJidsWithoutPlus.map((remoteJid) => ({ jidOptions: { contains: remoteJid } })),
        updatedAt: {
          gte: dayjs().subtract(configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP_DAYS, 'days').toDate(),
        },
      },
    });

    results = onWhatsappCache.map((item) => ({
      remoteJid: item.remoteJid,
      number: item.remoteJid.split('@')[0],
      jidOptions: item.jidOptions.split(','),
      lid: item.lid,
    }));
  }

  return results;
}

/**
 * Drops the cached record of a number.
 *
 * A cached entry asserts that a jid exists and is the one to send to. When the send itself fails,
 * that assertion is the prime suspect: without removing it the same wrong jid would be replayed on
 * every retry until IS_ON_WHATSAPP_DAYS expires. Dropping it costs one usync query on the next
 * attempt, and the answer is written back to the cache right after.
 */
export async function removeOnWhatsappCache(remoteJid: string) {
  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    return;
  }

  try {
    const jid = normalizeJid(remoteJid);
    if (!jid) {
      return;
    }

    const expandedJids = getAvailableNumbers(jid);

    const removed = await prismaRepository.isOnWhatsapp.deleteMany({
      where: {
        OR: [...expandedJids.map((option) => ({ jidOptions: { contains: option } })), { remoteJid: jid }],
      },
    });

    if (removed.count > 0) {
      logger.verbose(`[removeOnWhatsappCache] Dropped ${removed.count} stale record(s) for ${jid}`);
    }
  } catch (e) {
    logger.error(`[removeOnWhatsappCache] Error removing ${remoteJid}: `);
    logger.error(e);
  }
}
