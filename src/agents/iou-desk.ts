import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hashObject, randomHex, signObject, verifyObject, type Hex } from '../core/crypto.js'
import { debtOf, termsHash, type LoanTerms } from '../core/terms.js'
import { KIND } from '../market/kinds.js'
import { assertAssignable, signOwnership, verifyOwnership, type IouAssignment, type IouCertificate, type IouOwnership, type NoteSale } from '../market/iou.js'
import { awaitSettled } from '../rgb/wallet.js'
import type { Agent } from './agent.js'

interface Issued { certificate: IouCertificate }
interface Buy { sale_id: Hex; note_invoice: string; repayment_invoice: string }
interface PriceInvoice { sale_id: Hex; invoice: string }
interface Paid { sale_id: Hex; txid: Hex }
interface Assigned { sale_id: Hex; certificate: IouCertificate; assignments: IouAssignment[] }

export class IouDesk {
  readonly notes = new Map<Hex, IouOwnership>()
  private get notesFile(): string { return join(dirname(this.agent.party.rgb.dataDir), 'notes.json') }
  constructor(private readonly agent: Agent) {
    if (existsSync(this.notesFile)) {
      for (const owner of JSON.parse(readFileSync(this.notesFile, 'utf8')) as IouOwnership[]) {
        if (owner.holder_pk !== agent.pubkey || !verifyObject(owner, agent.pubkey)) throw new Error('saved note ownership signature invalid')
        this.notes.set(owner.certificate.loan_id, owner)
      }
    }
  }
  private save(): void { writeFileSync(this.notesFile, JSON.stringify([...this.notes.values()], null, 2), { mode: 0o600 }) }

  async sales(): Promise<NoteSale[]> {
    const a = this.agent
    const height = await a.chain.getHeight()
    const sales: NoteSale[] = []
    for (const event of await a.relay.publicEvents(KIND.NOTE_SALE)) {
      try {
        const sale = JSON.parse(event.content) as NoteSale
        assertAssignable(sale.terms)
        if (sale.ownership.holder_pk === event.pubkey && sale.expires_height > height && Number.isSafeInteger(sale.price) && sale.price > 0 && await verifyOwnership(sale.ownership, sale.terms, a.chain)) { await this.requireOpen(sale.ownership); sales.push(sale) }
      } catch { /* malformed or unsupported public listings do not enter the book */ }
    }
    return sales
  }

  async issue(terms: LoanTerms, invoice: string, lock: { txid: Hex; vout: number }): Promise<IouCertificate> {
    const a = this.agent
    if (terms.borrower_pk !== a.pubkey) throw new Error('only the borrower can issue its IOU')
    const loan_id = termsHash(terms)
    const amount = debtOf(terms)
    const asset_id = a.party.rgb.issueNia({ ticker: 'PBIOU', name: `PB-IOU ${loan_id.slice(0, 16)}`, precision: 6, amount })
    const sent = await a.sendRgb({ invoice, assetId: asset_id, amount }, { action: 'iou-transfer', terms, counterparty: terms.lender_pk, recipientOwner: terms.lender_pk })
    await awaitSettled(a.party.rgb, { assetId: asset_id, txid: sent.txid, kind: 'Send', mine: () => a.mine(1) })
    const certificate: IouCertificate = signObject({ domain: 'passbook-iou-v1' as const, loan_id, asset_id, amount, issuer_pk: a.pubkey, initial_holder_pk: terms.lender_pk, issuance_transfer_txid: sent.txid, lock_txid: lock.txid, lock_vout: lock.vout }, a.party.key.secretKey)
    await a.relay.send(KIND.NOTE_ISSUED, { certificate }, terms.lender_pk)
    await a.say('PB-IOU issued and transferred over RGB', { loan_id, asset_id, txid: sent.txid, amount })
    return certificate
  }

  async receiveIssued(terms: LoanTerms): Promise<IouOwnership> {
    const a = this.agent
    const { payload } = await a.relay.receive<Issued>(KIND.NOTE_ISSUED, terms.borrower_pk, { match: (p) => p.certificate.loan_id === termsHash(terms) })
    const c = payload.certificate
    const ownership = signOwnership(a.party.key, c, [])
    if (!await verifyOwnership(ownership, terms, a.chain)) throw new Error('IOU certificate does not authenticate this loan')
    const received = await awaitSettled(a.party.rgb, { assetId: c.asset_id, txid: c.issuance_transfer_txid, kind: 'ReceiveWitness', mine: () => a.mine(1) })
    if (received.amount !== c.amount) throw new Error('IOU amount does not equal debt')
    this.notes.set(c.loan_id, ownership)
    this.save()
    return ownership
  }

  private async requireOpen(owner: IouOwnership): Promise<void> {
    const c = owner.certificate
    if (!await this.agent.chain.rpc('gettxout', [c.lock_txid, c.lock_vout, true])) throw new Error('loan collateral already spent; IOU void for trading')
  }

  async offer(terms: LoanTerms, price: number, expires_height: number): Promise<NoteSale> {
    assertAssignable(terms)
    const ownership = this.notes.get(termsHash(terms))
    if (!ownership || ownership.holder_pk !== this.agent.pubkey || !await verifyOwnership(ownership, terms, this.agent.chain)) throw new Error('not the authenticated IOU holder')
    await this.requireOpen(ownership)
    if (!Number.isSafeInteger(price) || price <= 0 || expires_height <= await this.agent.chain.getHeight()) throw new Error('invalid sale price or expiry')
    if (this.agent.party.rgb.balance(ownership.certificate.asset_id).spendable !== ownership.certificate.amount) throw new Error('IOU is not wholly spendable')
    const sale = { sale_id: randomHex(), terms, ownership, price, expires_height }
    await this.agent.relay.publishPublic(KIND.NOTE_SALE, sale, [['d', sale.sale_id]])
    return sale
  }

  async sell(sale: NoteSale): Promise<IouOwnership> {
    assertAssignable(sale.terms)
    const a = this.agent
    const held = this.notes.get(sale.ownership.certificate.loan_id)
    if (!held || hashObject(held) !== hashObject(sale.ownership)) throw new Error('note ownership changed since this listing')
    await this.requireOpen(sale.ownership)
    const { payload: buy, event } = await a.relay.receive<Buy>(KIND.NOTE_BUY, null, { match: (p) => p.sale_id === sale.sale_id })
    if (await a.chain.getHeight() >= sale.expires_height || sale.ownership.holder_pk !== a.pubkey) throw new Error('sale expired or wrong seller')
    const invoice = a.party.rgb.invoice(sale.price, sale.terms.asset_id)
    await a.relay.send(KIND.NOTE_PRICE, { sale_id: sale.sale_id, invoice: invoice.invoice }, event.pubkey)
    const { payload: paid } = await a.relay.receive<Paid>(KIND.NOTE_PAID, event.pubkey, { match: (p) => p.sale_id === sale.sale_id })
    const payment = await awaitSettled(a.party.rgb, { assetId: sale.terms.asset_id, txid: paid.txid, kind: 'ReceiveWitness', mine: () => a.mine(1) })
    if (payment.amount !== sale.price || payment.recipientId !== invoice.recipientId) throw new Error('sale payment does not settle the agreed invoice')
    const c = sale.ownership.certificate
    const sent = await a.sendRgb({ invoice: buy.note_invoice, assetId: c.asset_id, amount: c.amount }, { action: 'iou-transfer', terms: sale.terms, counterparty: event.pubkey, recipientOwner: event.pubkey })
    await awaitSettled(a.party.rgb, { assetId: c.asset_id, txid: sent.txid, kind: 'Send', mine: () => a.mine(1) })
    const assignment: IouAssignment = signObject({ domain: 'passbook-iou-assignment-v1' as const, loan_id: c.loan_id, asset_id: c.asset_id, from_pk: a.pubkey, to_pk: event.pubkey, previous: hashObject(sale.ownership.assignments.at(-1) ?? c), note_txid: sent.txid, payment_txid: paid.txid, repayment_invoice: buy.repayment_invoice }, a.party.key.secretKey)
    await a.relay.send(KIND.NOTE_ASSIGNED, { sale_id: sale.sale_id, certificate: c, assignments: [...sale.ownership.assignments, assignment] }, event.pubkey)
    const { payload: owner } = await a.relay.receive<IouOwnership>(KIND.NOTE_OWNER, event.pubkey, { match: (p) => p.certificate.loan_id === c.loan_id })
    if (!await verifyOwnership(owner, sale.terms, a.chain) || owner.assignments.at(-1)?.note_txid !== sent.txid) throw new Error('buyer did not authenticate the assigned note')
    this.notes.delete(c.loan_id)
    this.save()
    return owner
  }

  async buy(sale: NoteSale): Promise<IouOwnership> {
    assertAssignable(sale.terms)
    const a = this.agent
    if (sale.expires_height <= await a.chain.getHeight() || !Number.isSafeInteger(sale.price) || sale.price <= 0 || !await verifyOwnership(sale.ownership, sale.terms, a.chain)) throw new Error('invalid note sale')
    await this.requireOpen(sale.ownership)
    const c = sale.ownership.certificate
    const note = a.party.rgb.invoice(c.amount, c.asset_id)
    const repayment = a.party.rgb.invoice(c.amount, sale.terms.asset_id, 30 * 24 * 3600)
    await a.relay.send(KIND.NOTE_BUY, { sale_id: sale.sale_id, note_invoice: note.invoice, repayment_invoice: repayment.invoice }, sale.ownership.holder_pk)
    const { payload: price } = await a.relay.receive<PriceInvoice>(KIND.NOTE_PRICE, sale.ownership.holder_pk, { match: (p) => p.sale_id === sale.sale_id })
    const payment = await a.sendRgb({ invoice: price.invoice, assetId: sale.terms.asset_id, amount: sale.price }, { action: 'iou-transfer', terms: sale.terms, counterparty: sale.ownership.holder_pk, recipientOwner: sale.ownership.holder_pk })
    await awaitSettled(a.party.rgb, { assetId: sale.terms.asset_id, txid: payment.txid, kind: 'Send', mine: () => a.mine(1) })
    await a.relay.send(KIND.NOTE_PAID, { sale_id: sale.sale_id, txid: payment.txid }, sale.ownership.holder_pk)
    const { payload: assigned } = await a.relay.receive<Assigned>(KIND.NOTE_ASSIGNED, sale.ownership.holder_pk, { match: (p) => p.sale_id === sale.sale_id })
    const owner = signOwnership(a.party.key, assigned.certificate, assigned.assignments)
    if (hashObject(owner.certificate) !== hashObject(c) || sale.ownership.assignments.some((prior, i) => hashObject(prior) !== hashObject(owner.assignments[i])) || owner.assignments.length !== sale.ownership.assignments.length + 1 || !await verifyOwnership(owner, sale.terms, a.chain) || owner.assignments.at(-1)?.repayment_invoice !== repayment.invoice) throw new Error('invalid assignment or repayment invoice')
    const got = await awaitSettled(a.party.rgb, { assetId: c.asset_id, txid: owner.assignments.at(-1)!.note_txid, kind: 'ReceiveWitness', mine: () => a.mine(1) })
    if (got.amount !== c.amount || got.recipientId !== note.recipientId) throw new Error('note did not settle in our invoice')
    this.notes.set(c.loan_id, owner)
    this.save()
    await a.relay.send(KIND.NOTE_OWNER, owner, sale.ownership.holder_pk)
    await a.relay.send(KIND.NOTE_OWNER, owner, sale.terms.borrower_pk)
    return owner
  }

  async returnNote(loanId: Hex, invoice: string): Promise<Hex> {
    const owner = this.notes.get(loanId)
    if (!owner) throw new Error('no note held')
    const c = owner.certificate
    const sent = await this.agent.sendRgb({ invoice, assetId: c.asset_id, amount: c.amount }, { action: 'iou-transfer', counterparty: c.issuer_pk, recipientOwner: c.issuer_pk })
    await awaitSettled(this.agent.party.rgb, { assetId: c.asset_id, txid: sent.txid, kind: 'Send', mine: () => this.agent.mine(1) })
    this.notes.delete(loanId)
    this.save()
    await this.agent.relay.send(KIND.NOTE_RETURNED, { loan_id: loanId, asset_id: c.asset_id, txid: sent.txid }, c.issuer_pk)
    return sent.txid
  }
}
