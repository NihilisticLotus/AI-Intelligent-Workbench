// 模型输入只从 AttachmentService 的受限句柄读取，保留原始上传身份。
import { IndependentModelAttachment } from '@aic/protocol';
import { AttachmentService, sniffAttachment } from '../attachments';
import { ModelTransportError } from './model-http';

export class IndependentAttachments {
  constructor(private attachments: AttachmentService) {}
  async load(taskId: string, attachmentId: string, signal: AbortSignal): Promise<IndependentModelAttachment> {
    try {
      if (signal.aborted) throw new ModelTransportError('cancelled');
      const snapshot = this.attachments.snapshot(taskId, attachmentId), info = snapshot.info;
      const maxBytes = info.kind === 'image' ? 5 * 1024 * 1024 : 512 * 1024;
      if (info.size > maxBytes || info.kind !== 'image' && !info.mime.startsWith('text/plain')) throw new ModelTransportError('request');
      const read = await this.attachments.read(taskId, attachmentId, signal, maxBytes), shape = sniffAttachment(read.bytes);
      if (info.kind === 'image' ? shape.kind !== 'image' || shape.mime !== info.mime || shape.width !== info.width || shape.height !== info.height
        : shape.kind !== 'file' || shape.mime !== 'text/plain; charset=utf-8') throw new ModelTransportError('request');
      if (JSON.stringify(this.attachments.snapshot(taskId, attachmentId)) !== JSON.stringify(snapshot)) throw new ModelTransportError('request');
      if (signal.aborted) throw new ModelTransportError('cancelled');
      this.attachments.markUsed(taskId, [attachmentId]);
      return IndependentModelAttachment.parse({ attachmentId, name: info.name, kind: info.kind === 'image' ? 'image' : 'text', mime: info.mime, base64: read.bytes.toString('base64') });
    } catch (error) { throw signal.aborted ? new ModelTransportError('cancelled') : error instanceof ModelTransportError ? error : new ModelTransportError('request'); }
  }
}
