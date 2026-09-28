# Certificate Validation Service

Microservicio que valida certificados de e.firma del SAT: **vigencia**, **cadena de confianza** y
**estado de revocación vía OCSP**. Lo consume `signature-server` al firmar con firma avanzada y al
reintentar el sellado de documentos que quedaron pendientes.

No recibe nunca la llave privada (`.key`) ni su contraseña: sólo el certificado público (`.cer`).

## Variables de entorno

| Variable | Obligatoria | Default | Descripción |
| --- | --- | --- | --- |
| `API_KEY` | Sí | — | Clave que se exige en `x-api-key`. Sin ella el servicio no arranca. |
| `PORT` | No | `3003` | Puerto HTTP. |
| `OCSP_URL` | No | `https://cfdi.sat.gob.mx/edofiel` | Respondedor OCSP del SAT. |
| `OCSP_TIMEOUT_MS` | No | `5000` | Tiempo máximo de espera de la consulta OCSP. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Sí | `localhost` / `5432` / `postgres` / — / `certificate_validation_db` | Postgres de las incidencias. Base propia del servicio. |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Sí | `localhost` / `6379` / — | Lock distribuido entre réplicas. |
| `KAFKA_BROKER` / `KAFKA_CLIENT_ID` / `KAFKA_CONSUMER_GROUP_ID` | Sí | `localhost:9094` / `certificate-validation-service` / `certificate-validation-service-consumer` | Publicación y consumo de los fallos OCSP. |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` / `INCIDENT_ALERT_RECIPIENTS` | No* | — | Correos al equipo operativo (destinatarios separados por comas). *Sin ellos el servicio arranca, pero los avisos no salen. |
| `INCIDENT_ALERT_THRESHOLD` | No | `3` | Fallos (intentos afectados + chequeos fallidos) que disparan el aviso. |
| `OCSP_HEALTH_CHECK_TIMEOUT_MS` | No | `OCSP_TIMEOUT_MS` | Timeout del chequeo de salud. |
| `OCSP_HEALTH_CHECK_CERTIFICATE` | No | — | `.cer` vigente del SAT en Base64 para que el chequeo sea una consulta OCSP real. |

Los certificados de confianza (AC del SAT) viven en `src/trust-anchors/` y se copian a
`dist/trust-anchors/` al compilar.

## Endpoint

`POST /api/v1/certificates/validate` — documentación interactiva en `/docs`.

```json
{
  "certificate": "<.cer en Base64, DER o PEM>",
  "referenceDate": "2026-09-15T12:00:00.000Z",
  "allowUnverifiedRevocation": false
}
```

- `referenceDate` (opcional): fecha contra la que se evalúa la vigencia. No puede estar en el futuro.
- `allowUnverifiedRevocation` (opcional): si el SAT no responde, en vez de `503` se devuelve `200` con
  `revocation.status = "UNVERIFIED"` y sin `ocspEvidence`.

Las comprobaciones corren en orden (formato → vigencia → cadena → OCSP) y se detienen en la primera
que falla.

## Errores

Todos los errores, incluidos los de API Key y rutas inexistentes, responden con la misma estructura:

```json
{
  "statusCode": 400,
  "code": "INVALID_CERTIFICATE",
  "message": "El certificado proporcionado no es válido",
  "timestamp": "2026-09-15T12:00:00.000Z",
  "path": "/api/v1/certificates/validate"
}
```

| `code` | HTTP | Cuándo |
| --- | --- | --- |
| `INVALID_API_KEY` | 401 | Falta `x-api-key` o no coincide. |
| `INVALID_REQUEST` | 400 | El cuerpo no cumple el DTO o no es JSON válido. |
| `INVALID_CERTIFICATE` | 400 | El contenido no es un certificado X.509. |
| `CERTIFICATE_EXPIRED` | 422 | Vencido en la fecha de referencia. |
| `CERTIFICATE_NOT_YET_VALID` | 422 | Aún no vigente en la fecha de referencia. |
| `INVALID_TRUST_CHAIN` | 422 | No encadena a una AC de confianza del SAT. |
| `CERTIFICATE_REVOKED` | 422 | El SAT lo reporta revocado. |
| `OCSP_SERVICE_UNAVAILABLE` | 503 | El SAT no respondió (y no se permitió seguir sin verificar). |
| `RESOURCE_NOT_FOUND` | 404 | La ruta no existe. |
| `CERTIFICATE_VALIDATION_ERROR` | 500 | Cualquier fallo inesperado. |

Los consumidores deben decidir por `code`, nunca por `message`. El detalle técnico de cada error se
registra en el log del servicio y nunca se incluye en la respuesta.

## Incidencias de disponibilidad de OCSP

Cuando el SAT no responde, el servicio agrupa los intentos afectados en **una sola incidencia** y
avisa al equipo operativo **dos veces como máximo**: al caer y al recuperarse.

1. **Cada intento de validación que no pudo consultar OCSP** (timeout, red, respuesta de error del
   SAT) se registra en el log y publica un evento `OCSP_VALIDATION_FAILED` en el topic
   `certificate-validation.ocsp-validation-failed`, con o sin `allowUnverifiedRevocation`. Un
   certificado **revocado** no es una caída y no publica nada. Publicar nunca retrasa ni rompe la
   respuesta.
2. **El consumer** guarda cada evento en `ocsp_failure_events` (llave primaria `eventId`: una
   reentrega de Kafka no vuelve a sumar) y lo suma a la incidencia `OPEN` del servicio en
   `service_incidents`, creándola si no existe. El índice único parcial
   `UQ_service_incidents_open_per_service` impide que haya dos abiertas.
3. **Cada 5 minutos**, la réplica que obtiene el lock `certificate-validation-service:incident` en
   Redis hace un chequeo de salud contra OCSP si hay una incidencia abierta. Si sigue fallando, la
   mantiene abierta; si responde, la cierra.
4. **Correos:** el aviso sale una vez, al alcanzar `INCIDENT_ALERT_THRESHOLD` fallos; el resumen de
   recuperación sale una vez, al cerrarse, con inicio, recuperación, duración e intentos afectados.
   Una incidencia que se recupera antes del umbral se cierra sin correo. Un envío fallido se
   reintenta dentro de la ejecución y en los ciclos siguientes, hasta 10 intentos, y el último
   error queda en `last_notification_error`.
5. Un fallo posterior abre una **incidencia nueva**. Un evento que llega tarde (ocurrió antes de que
   se cerrara una incidencia) se suma a esa incidencia ya cerrada, en vez de abrir otra.

Consulta para auditoría: `GET /api/v1/incidents?limit=20` (con `x-api-key`).

## Desarrollo

Necesita Postgres, Redis y Kafka (en local, los contenedores de Signature). La base se crea una vez;
las migraciones corren solas al arrancar.

```bash
npm install
docker exec signature_postgres createdb -U postgres certificate_validation_db
API_KEY=dev-key npm run start:dev
npm test           # unitarias
npm run test:e2e   # endpoint completo con OCSP simulado + incidencias contra un Postgres real
                   # (crea y borra una base desechable; usa DB_HOST/DB_PORT/DB_USER/DB_PASSWORD)
npm run migration:revert   # tras npm run build
```
