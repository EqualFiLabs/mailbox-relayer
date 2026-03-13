import type { FastifyLoggerInstance } from 'fastify';

export type AlertSeverity = 'warning' | 'error' | 'critical';

export interface AlertPayload {
  kind: string;
  severity: AlertSeverity;
  agreementId?: string;
  provider?: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface AlertSender {
  send(payload: AlertPayload): Promise<void>;
}

export class DisabledAlertSender implements AlertSender {
  async send(): Promise<void> {
    // no-op
  }
}

export class WebhookAlertSender implements AlertSender {
  constructor(
    private readonly webhookUrl: string,
    private readonly token?: string,
    private readonly logger?: FastifyLoggerInstance
  ) {}

  async send(payload: AlertPayload): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger?.warn(
          { status: response.status, kind: payload.kind, agreementId: payload.agreementId },
          'alert webhook returned non-2xx status'
        );
      }
    } catch (error) {
      this.logger?.warn(
        { error: String(error), kind: payload.kind, agreementId: payload.agreementId },
        'alert webhook request failed'
      );
    }
  }
}

export interface AlertingServiceOptions {
  now?: () => string;
  logger?: FastifyLoggerInstance;
}

export class AlertingService {
  private readonly now: () => string;

  constructor(
    private readonly sender: AlertSender,
    options: AlertingServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async emitAlert(
    kind: string,
    severity: AlertSeverity,
    message: string,
    details?: {
      agreementId?: string;
      provider?: string;
      details?: Record<string, unknown>;
    }
  ): Promise<void> {
    const payload: AlertPayload = {
      kind,
      severity,
      message,
      timestamp: this.now(),
      ...(details?.agreementId ? { agreementId: details.agreementId } : {}),
      ...(details?.provider ? { provider: details.provider } : {}),
      ...(details?.details ? { details: details.details } : {}),
    };

    await this.sender.send(payload);
  }

  async meteringFailure(
    agreementId: string,
    provider: string,
    error: unknown,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.emitAlert('metering_failure', 'error', 'Metering poll failed', {
      agreementId,
      provider,
      details: {
        error: String(error),
        ...details,
      },
    });
  }

  async terminationFailure(
    agreementId: string,
    provider: string,
    error: unknown,
    attemptNumber: number,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.emitAlert('termination_failure', 'warning', 'Provider termination attempt failed', {
      agreementId,
      provider,
      details: {
        error: String(error),
        attempt: attemptNumber,
        ...details,
      },
    });
  }

  async terminationExhausted(
    agreementId: string,
    provider: string,
    attempts: number,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.emitAlert('termination_exhausted', 'critical', 'Termination retries exhausted', {
      agreementId,
      provider,
      details: {
        attempts,
        ...details,
      },
    });
  }

  async settlementFailure(
    submissionId: string,
    agreementId: string,
    error: unknown,
    attemptNumber: number,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.emitAlert('settlement_failure', 'warning', 'Usage settlement attempt failed', {
      agreementId,
      details: {
        submissionId,
        error: String(error),
        attempt: attemptNumber,
        ...details,
      },
    });
  }

  async settlementExhausted(
    submissionId: string,
    agreementId: string,
    attempts: number,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.emitAlert('settlement_exhausted', 'critical', 'Settlement retries exhausted', {
      agreementId,
      details: {
        submissionId,
        attempts,
        ...details,
      },
    });
  }
}
