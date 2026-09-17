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

## Desarrollo

```bash
npm install
API_KEY=dev-key npm run start:dev
npm test           # unitarias
npm run test:e2e   # endpoint completo, con certificados de prueba y OCSP simulado
```
