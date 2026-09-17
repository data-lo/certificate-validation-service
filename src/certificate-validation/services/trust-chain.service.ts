import { Inject, Injectable } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';

import { InvalidTrustChainException } from '../exceptions/certificate.exceptions';
import { TRUST_ANCHORS } from './trust-anchors.provider';

/** Resultado de recorrer la cadena de confianza. */
export interface TrustChainResult {
  /** Emisor inmediato: la AC que firmó el certificado. Es la que firma la respuesta OCSP. */
  issuer: X509Certificate;
  /** AC raíz de confianza en la que terminó la cadena. */
  root: X509Certificate;
}

@Injectable()
export class TrustChainService {
  /**
   * @param trustAnchors - AC raíz e intermedias del SAT consideradas de confianza.
   * @returns El servicio listo para validar cadenas.
   *
   * @example
   * ```ts
   * const service = new TrustChainService(loadTrustAnchors(DEFAULT_TRUST_ANCHORS_DIR));
   * ```
   */
  constructor(
    @Inject(TRUST_ANCHORS) private readonly trustAnchors: X509Certificate[],
  ) {}

  /**
   * Verifica que el certificado encadene hasta una raíz de confianza y devuelve su emisor inmediato.
   *
   * Migrado sin cambios de criterio desde `EfirmaService.validarCadenaConfianza` de
   * `signature-server`: en cada eslabón se busca en el almacén una AC que haya emitido al actual Y
   * cuya llave pública verifique su firma, hasta llegar a un autofirmado que esté en el almacén.
   * Devuelve el emisor INMEDIATO (no la raíz) porque es el que la consulta OCSP necesita.
   *
   * @param certificate - Certificado del firmante.
   * @returns El emisor inmediato y la raíz en la que terminó la cadena.
   *
   * @throws {InvalidTrustChainException} Si un eslabón no tiene emisor de confianza, si la raíz no
   * está en el almacén o si la cadena forma un ciclo.
   *
   * @example
   * ```ts
   * const { issuer, root } = trustChainService.validate(new X509Certificate(cerBuffer));
   * ```
   */
  validate(certificate: X509Certificate): TrustChainResult {
    let current = certificate;
    let immediateIssuer: X509Certificate | undefined;
    const visited = new Set<string>();

    while (true) {
      if (current.issuer === current.subject) {
        const isTrustedRoot = this.trustAnchors.some(
          (anchor) => anchor.fingerprint256 === current.fingerprint256,
        );

        if (!isTrustedRoot) {
          throw new InvalidTrustChainException(
            `La raíz "${oneLine(current.subject)}" no está en el almacén de confianza`,
          );
        }

        // Cadena de un solo nivel: el propio certificado es raíz y emisor a la vez.
        return { issuer: immediateIssuer ?? current, root: current };
      }

      const issuer = this.trustAnchors.find(
        (candidate) =>
          current.checkIssued(candidate) && current.verify(candidate.publicKey),
      );

      if (!issuer) {
        throw new InvalidTrustChainException(
          `No se encontró (o no valida criptográficamente) el emisor "${oneLine(current.issuer)}"`,
        );
      }

      immediateIssuer ??= issuer;

      if (visited.has(issuer.fingerprint256)) {
        throw new InvalidTrustChainException(
          'Ciclo detectado al validar la cadena de confianza',
        );
      }

      visited.add(issuer.fingerprint256);
      current = issuer;
    }
  }
}

/**
 * Pasa un nombre distinguido de Node (un atributo por línea) a una sola línea legible.
 *
 * @param distinguishedName - `subject` o `issuer` tal como lo entrega `X509Certificate`.
 * @returns Los atributos separados por coma.
 *
 * @example
 * ```ts
 * oneLine('C=MX\nO=SAT'); // 'C=MX, O=SAT'
 * ```
 */
export function oneLine(distinguishedName: string): string {
  return distinguishedName.split('\n').filter(Boolean).join(', ');
}
