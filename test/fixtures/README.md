# Certificados de prueba

Generados con OpenSSL 3.5 el 2026-09-17. **No son de la e.firma ni del SAT**: sólo reproducen su forma
(raíz → intermedia → certificado del firmante) para probar la cadena de confianza sin salir a la red.
Las llaves privadas se descartaron al generarlos.

| Archivo | Qué es |
| --- | --- |
| `trust-anchors/root.crt` | AC raíz autofirmada (PEM), válida hasta 2126. |
| `trust-anchors/intermediate.crt` | AC intermedia emitida por la raíz (PEM). |
| `leaf.cer` | Certificado del firmante emitido por la intermedia (DER), vigente del 2026-09-17 al 2122-07-16. |
| `untrusted-leaf.cer` | Certificado emitido por una raíz que NO está en `trust-anchors/` (DER). |
