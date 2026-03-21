# Observability Stack

A Docker Compose environment for collecting and visualizing OpenTelemetry telemetry sent from GitHub Copilot.

## Prerequisites

- Docker / Docker Compose

## Starting

```bash
docker compose up -d
```

To wait for all services to be ready:

```bash
docker compose --profile ready up -d ready
# All services are healthy once the ready container is running
```

## Service List

| Service | Host Port | Purpose |
|---------|-----------|---------|
| Grafana | [localhost:46379](http://localhost:46379) | Dashboard / visualization |
| Prometheus | [localhost:45247](http://localhost:45247) | Metrics storage |
| Loki | localhost:44631 | Log storage |
| Tempo | localhost:44857 | Trace storage |
| OTel Collector (gRPC) | localhost:45573 | Telemetry receiver (OTLP gRPC) |
| OTel Collector (HTTP) | localhost:45574 | Telemetry receiver (OTLP HTTP) |

## Copilot Connection Settings

### GitHub Copilot Chat (VS Code)

Add the following to your VS Code `settings.json`:

For gRPC connection:

```jsonc
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-grpc",
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:45573"
}
```

For HTTP connection:

```jsonc
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:45574"
}
```

### GitHub Copilot CLI

Set the following environment variables. The CLI exporter supports only `otlp-http`.

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:45574
```

`COPILOT_OTEL_EXPORTER_TYPE` defaults to `otlp-http`, so no configuration is needed.

## Dashboards

Provisioned dashboards are available once you open Grafana.

### Copilot Token Usage

Visualizes per-model token usage based on the native metric (`gen_ai.client.token.usage`) sent by Copilot.

- **Input Tokens / 1m** — Input token count over time, by model
- **Output Tokens / 1m** — Output token count over time, by model
- **Total Tokens / 1m** — Sum of input and output (stacked)

Use the `model` dropdown at the top of the screen to switch or multi-select models. Change the time range using Grafana's standard time picker.

### Grafana Login Information

| Item | Value |
|------|-------|
| URL | http://localhost:46379 |
| User | admin |
| Password | admin |

Anonymous access is also enabled (Admin role).

## Stopping

```bash
docker compose down
```

To completely remove including data:

```bash
docker compose down -v
```
