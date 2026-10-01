import { useMemo, useState } from 'react'
import { formatMoney } from '../lib/studioEngine'
import { useApp } from '../ui/studioContext'
import {
  Card,
  CardHeader,
  SectionLabel,
  Badge,
  Button,
  Avatar,
  Segmented,
  EmptyState,
  MetaRow,
} from '../ui/primitives'
import {
  holdingsForCustomer,
  casesForCustomer,
  holdingsForProduct,
  totalBalance,
} from '../ui/selectors'
import { priorityLabel, priorityTone } from '../ui/constants'
import { maskCard, cx } from '../ui/util'
import { Users, Search, CreditCard, Wallet, ShieldCheck, FlaskConical, Layers, Building2 } from '../ui/icons'

export function CustomersPage() {
  const { studio, ui } = useApp()
  const { state } = studio
  const { snapshot } = state
  const [view, setView] = useState<'people' | 'products'>('people')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return snapshot.customers
    return snapshot.customers.filter(
      (customer) =>
        customer.name.toLowerCase().includes(term) ||
        customer.email.toLowerCase().includes(term) ||
        customer.customerNumber.toLowerCase().includes(term) ||
        customer.accountNumber.toLowerCase().includes(term),
    )
  }, [snapshot.customers, query])

  const selectedCustomerId = ui.selectedCustomerId ?? snapshot.customers[0]?.id
  const customer = snapshot.customers.find((item) => item.id === selectedCustomerId)
  const holdings = useMemo(() => (customer ? holdingsForCustomer(snapshot, customer.id) : []), [snapshot, customer])
  const cases = useMemo(() => (customer ? casesForCustomer(snapshot, customer.id) : []), [snapshot, customer])

  return (
    <div className="page">
      <section className="page-head page-head--row">
        <div>
          <SectionLabel>Customers &amp; products</SectionLabel>
          <h1 className="page-title">Customer directory</h1>
          <p className="page-lede">Synthetic Gravity Bank contacts, their holdings and the product catalogue behind them.</p>
        </div>
        <Segmented
          ariaLabel="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'people', label: 'People', icon: <Users size={15} /> },
            { value: 'products', label: 'Products', icon: <Layers size={15} /> },
          ]}
        />
      </section>

      {view === 'people' ? (
        <div className="customers-layout">
          <Card className="customers-list-card">
            <div className="customers-search">
              <span aria-hidden="true"><Search size={15} /></span>
              <input
                type="search"
                aria-label="Search customers"
                placeholder="Search name, email or number…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {filtered.length === 0 ? (
              <EmptyState icon={<Users size={20} />} title="No matches" description="Try a different search." />
            ) : (
              <ul className="customer-list">
                {filtered.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={cx('customer-row', selectedCustomerId === item.id && 'customer-row--active')}
                      onClick={() => ui.selectCustomer(item.id)}
                    >
                      <Avatar name={item.name} size="sm" />
                      <span className="customer-row__text">
                        <span className="customer-row__name">{item.name}</span>
                        <span className="customer-row__email">{item.email}</span>
                      </span>
                      <span className="customer-row__risk">
                        <Badge soft tone={/high/i.test(item.risk) ? 'danger' : /medium/i.test(item.risk) ? 'warning' : 'neutral'}>
                          {item.risk || '—'}
                        </Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="customer-detail">
            {!customer ? (
              <Card>
                <EmptyState icon={<Users size={22} />} title="Select a customer" description="Pick someone to see their profile and holdings." />
              </Card>
            ) : (
              <>
                <Card>
                  <div className="profile-head">
                    <Avatar name={customer.name} size="lg" />
                    <div className="profile-head__text">
                      <h2 className="profile-head__name">{customer.name}</h2>
                      <p className="profile-head__email">{customer.email}</p>
                    </div>
                    <Button
                      variant="primary"
                      icon={<FlaskConical size={15} />}
                      onClick={() => ui.startTestForCustomer(customer.id, holdings[0]?.id)}
                    >
                      Create test for customer
                    </Button>
                  </div>
                  <MetaRow
                    items={[
                      { label: 'Customer no.', value: customer.customerNumber || '—' },
                      { label: 'Account no.', value: customer.accountNumber || '—' },
                      { label: (<><ShieldCheck size={13} /> KYC</>), value: <Badge soft tone={/verified|pass/i.test(customer.kyc) ? 'success' : 'warning'}>{customer.kyc || '—'}</Badge> },
                      { label: 'Risk', value: <Badge soft tone={/high/i.test(customer.risk) ? 'danger' : /medium/i.test(customer.risk) ? 'warning' : 'neutral'}>{customer.risk || '—'}</Badge> },
                    ]}
                  />
                  {customer.context ? <p className="profile-context">{customer.context}</p> : null}
                </Card>

                <Card>
                  <CardHeader
                    label="Holdings"
                    title={`${holdings.length} product${holdings.length === 1 ? '' : 's'}`}
                    actions={<Badge soft tone="lavender"><Wallet size={13} /> {formatMoney(totalBalance(holdings))}</Badge>}
                  />
                  {holdings.length === 0 ? (
                    <EmptyState icon={<Wallet size={20} />} title="No holdings" description="This customer has no linked products in scope." />
                  ) : (
                    <div className="holding-grid">
                      {holdings.map((holding) => (
                        <div className="holding-card" key={holding.id}>
                          <div className="holding-card__top">
                            <span className="holding-card__name">{holdingDisplayName(holding)}</span>
                            <Badge soft tone={/active|open/i.test(holding.status) ? 'success' : 'neutral'}>{holding.status || '—'}</Badge>
                          </div>
                          <div className="holding-card__row">
                            <span>{holding.type}</span>
                            <span className="holding-card__num">{holdingSuffix(holding) ? `Ending ${holdingSuffix(holding)}` : 'No account reference'}</span>
                          </div>
                          {holding.balance !== undefined ? (
                            <p className="holding-card__balance">{formatMoney(holding.balance)}</p>
                          ) : null}
                          {holding.cardLastFour ? (
                            <p className="holding-card__card">
                              <CreditCard size={13} /> {maskCard(holding.cardLastFour)}
                              {holding.cardStatus ? <span className="muted-note"> · {holding.cardStatus}</span> : null}
                            </p>
                          ) : null}
                          {holding.notes ? <p className="holding-card__notes">{holding.notes}</p> : null}
                          <Button
                            variant="subtle"
                            size="sm"
                            icon={<FlaskConical size={13} />}
                            onClick={() => ui.startTestForCustomer(customer.id, holding.id)}
                          >
                            Test this holding
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {cases.length > 0 ? (
                  <Card>
                    <CardHeader label="Cases" title={`${cases.length} linked case${cases.length === 1 ? '' : 's'}`} />
                    <ul className="mini-case-list">
                      {cases.map((item) => (
                        <li key={item.id}>
                          <div className="mini-case mini-case--static">
                            <span className="mini-case__main">
                              <span className="mini-case__title">{item.title || item.number}</span>
                              <span className="mini-case__meta">{item.number} · {item.status}</span>
                            </span>
                            <Badge soft tone={priorityTone(item.priority)}>{priorityLabel(item.priority)}</Badge>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : (
        <Card>
          <CardHeader label="Catalogue" title={`${snapshot.products.length} products`} description="Each product and the holdings linked to it in the current snapshot." />
          {snapshot.products.length === 0 ? (
            <EmptyState icon={<Layers size={20} />} title="No products" description="The product table returned nothing in this snapshot." />
          ) : (
            <div className="product-grid">
              {snapshot.products.map((product) => {
                const linked = holdingsForProduct(snapshot, product.id)
                const holders = new Set(linked.map((item) => item.customerId)).size
                return (
                  <div className="product-card" key={product.id}>
                    <div className="product-card__icon" aria-hidden="true"><Building2 size={18} /></div>
                    <div className="product-card__head">
                      <span className="product-card__name">{product.name}</span>
                      <Badge soft tone={/active/i.test(product.state) ? 'success' : 'neutral'}>{product.state || '—'}</Badge>
                    </div>
                    <p className="product-card__number">{product.number}</p>
                    {product.description ? <p className="product-card__desc">{product.description}</p> : null}
                    <div className="product-card__foot">
                      <Badge soft tone="lavender">{linked.length} holdings</Badge>
                      <Badge soft tone="neutral">{holders} customers</Badge>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
import { holdingDisplayName, holdingSuffix } from '../lib/holdingLabels'
