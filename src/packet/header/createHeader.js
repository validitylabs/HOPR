'use strict'

const secp256k1 = require('secp256k1')
const crypto = require('crypto')
const bs58 = require('bs58')
const forEachRight = require('lodash.foreachright');

const prg = require('../../crypto/prg')
const { hash, bufferXOR } = require('../../utils')
const c = require('../../constants')

const p = require('./parameters')

module.exports = (Header, header, peerIds) => {
    function checkPeerIds() {
        if (!Array.isArray(peerIds))
            throw Error(`Expected array of peerIds. Got '${typeof publicKeys}' instead.`)

        if (peerIds.length > c.MAX_HOPS)
            peerIds = peerIds.slice(0, c.MAX_HOPS)

        peerIds.forEach((peerId, index) => {
            if (peerId === undefined || peerId.id === undefined || peerId.pubKey === undefined)
                throw Error(`Invalid peerId at index ${index}.`)
        })
    }

    function generateKeyShares() {
        let done = false, secrets, privKey

        // Generate the Diffie-Hellman key shares and
        // the respective blinding factors for the
        // relays.
        // There exists a negligible, but NON-ZERO,
        // probability that the key share is chosen
        // such that it yields non-group elements.
        do {
            // initialize values
            let mul = Buffer.alloc(p.PRIVATE_KEY_LENGTH).fill(0)
            mul[p.PRIVATE_KEY_LENGTH - 1] = 1
            const G = secp256k1.publicKeyCreate(mul)

            secrets = []

            do {
                privKey = crypto.randomBytes(p.PRIVATE_KEY_LENGTH)
            } while (!secp256k1.privateKeyVerify(privKey))

            header.alpha
                .fill(secp256k1.publicKeyCreate(privKey), 0, p.COMPRESSED_PUBLIC_KEY_LENGTH)

            privKey.copy(mul, 0, 0, p.PRIVATE_KEY_LENGTH)

            peerIds.forEach((peerId, index) => {
                // parallel
                // thread 1
                const alpha = secp256k1.publicKeyTweakMul(G, mul)
                // secp256k1.publicKeyVerify(alpha)

                // thread 2
                const secret = secp256k1.publicKeyTweakMul(peerId.pubKey.marshal(), mul)
                // secp256k1.publicKeyVerify(secret)
                // end parallel

                if (!secp256k1.publicKeyVerify(alpha) || !secp256k1.publicKeyVerify(secret))
                    return

                mul = secp256k1.privateKeyTweakMul(mul, Header.deriveBlinding(alpha, secret))

                if (!secp256k1.privateKeyVerify(mul))
                    return

                secrets.push(secret)

                if (index == peerIds.length - 1)
                    done = true
            })
        } while (!done)

        return secrets
    }

    function generateFiller(secrets) {
        const filler = Buffer.alloc(p.PER_HOP_SIZE * (c.MAX_HOPS - 1), 0)
        let length, start, end

        for (let index = 0; index < (c.MAX_HOPS - 1); index++) {
            let { key, iv } = Header.derivePRGParameters(secrets[index])

            start = p.LAST_HOP_SIZE + (c.MAX_HOPS - 1 - index) * p.PER_HOP_SIZE
            end = p.LAST_HOP_SIZE + c.MAX_HOPS * p.PER_HOP_SIZE

            length = (index + 1) * p.PER_HOP_SIZE

            bufferXOR(
                filler.slice(0, length),
                prg.createPRG(key, iv).digest(start, end)
            ).copy(filler, 0, 0, length)
        }

        return filler
    }

    function createBetaAndGamma(secrets, filler, identifier) {
        const tmp = Buffer.alloc(Header.BETA_LENGTH - p.PER_HOP_SIZE)

        forEachRight(secrets, (secret, index) => {
            const { key, iv } = Header.derivePRGParameters(secret)

            let paddingLength = (c.MAX_HOPS - secrets.length) * p.PER_HOP_SIZE

            if (index === secrets.length - 1) {
                header.beta
                    .fill(peerIds[index].pubKey.marshal(), 0, p.DESINATION_SIZE)
                    .fill(identifier, p.DESINATION_SIZE, p.DESINATION_SIZE + p.IDENTIFIER_SIZE)

                if (paddingLength > 0) {
                    header.beta.fill(0, p.LAST_HOP_SIZE, paddingLength)
                }

                header.beta
                    .fill(
                        bufferXOR(
                            header.beta.slice(0, p.LAST_HOP_SIZE),
                            prg.createPRG(key, iv).digest(0, p.LAST_HOP_SIZE)
                        ),
                        0, p.LAST_HOP_SIZE)
                    .fill(filler, p.LAST_HOP_SIZE + paddingLength, Header.BETA_LENGTH)

            } else {
                tmp
                    .fill(header.beta, 0, Header.BETA_LENGTH - p.PER_HOP_SIZE)

                header.beta
                    .fill(peerIds[index + 1].pubKey.marshal(), 0, p.ADDRESS_SIZE)
                    .fill(header.gamma, p.ADDRESS_SIZE, p.ADDRESS_SIZE + p.MAC_SIZE)
                    .fill(secp256k1.publicKeyCreate(Header.deriveTransactionKey(secrets[index + 1])), p.ADDRESS_SIZE + p.MAC_SIZE, p.ADDRESS_SIZE + p.MAC_SIZE + p.COMPRESSED_PUBLIC_KEY_LENGTH)
                    .fill(tmp, p.PER_HOP_SIZE, Header.BETA_LENGTH)

                if (secrets.length > 2) {
                    let key
                    if (index < secrets.length - 2) {
                        key = secp256k1.privateKeyTweakAdd(
                            Header.deriveTransactionKey(secrets[index + 1]),
                            Header.deriveTransactionKey(secrets[index + 2])
                        )
                    } else if (index == secrets.length - 2) {
                        key = Header.deriveTransactionKey(secrets[index + 1])
                    }
                    header.beta
                        .fill(key, p.ADDRESS_SIZE + p.MAC_SIZE + p.COMPRESSED_PUBLIC_KEY_LENGTH, p.ADDRESS_SIZE + p.MAC_SIZE + p.COMPRESSED_PUBLIC_KEY_LENGTH + p.KEY_LENGTH)
                }
                header.beta
                    .fill(
                        bufferXOR(
                            header.beta,
                            prg.createPRG(key, iv).digest(0, Header.BETA_LENGTH)
                        ), 0, Header.BETA_LENGTH)
            }

            header.gamma
                .fill(Header.createMAC(secret, header.beta), 0, p.MAC_SIZE)
        })
    }

    function deriveKey(a, b) {
        return secp256k1.privateKeyTweakAdd(
            Header.deriveTransactionKey(a),
            Header.deriveTransactionKey(b)
        )
    }

    function printValues(header, secrets) {
        console.log(
            peerIds.reduce((str, peerId, index) => {
                str = str + '\nsecret[' + index + ']: ' + bs58.encode(secrets[index]) + '\n' +
                    'peerId[' + index + ']: ' + peerId.toB58String() + '\n'
                    + 'peerId[' + index + '] pubkey ' + bs58.encode(peerId.pubKey.marshal())

                return str
            }, header.toString()))
    }

    checkPeerIds()
    const secrets = generateKeyShares(peerIds)
    const identifier = crypto.randomBytes(p.IDENTIFIER_SIZE)
    const filler = generateFiller(secrets)
    createBetaAndGamma(secrets, filler, identifier)

    // printValues(header, secrets)

    return {
        header: header,
        secrets: secrets,
        identifier: identifier
    }
}

