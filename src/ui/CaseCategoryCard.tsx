import { useId, useRef, useState } from 'react'
import type { CategoryCount } from './selectors'
import { Card, CardHeader, EmptyState, IconButton } from './primitives'
import { ClipboardCheck, Info, X } from './icons'

export function CaseCategoryCard({ categories }: { categories: CategoryCount[] }) {
  const [noteVisible, setNoteVisible] = useState(true)
  const noteId = useId()
  const noteToggle = useRef<HTMLButtonElement>(null)
  const total = categories.reduce((sum, item) => sum + item.count, 0)
  const largest = Math.max(1, ...categories.map(item => item.count))
  const shown = categories.slice(0, 7)

  const dismissNote = () => {
    setNoteVisible(false)
    noteToggle.current?.focus()
  }

  return (
    <Card className="case-category-card">
      <CardHeader
        label="Request mix"
        title="Case categories"
        description={`${total} loaded ${total === 1 ? 'case' : 'cases'} across ${categories.length} ${categories.length === 1 ? 'category' : 'categories'}`}
        actions={
          <button
            ref={noteToggle}
            type="button"
            className="icon-btn"
            aria-label="About case categories"
            title="About case categories"
            aria-expanded={noteVisible}
            aria-controls={noteVisible ? noteId : undefined}
            onClick={() => setNoteVisible(visible => !visible)}
          >
            <Info size={16} aria-hidden="true" />
          </button>
        }
      />
      {shown.length === 0 ? (
        <EmptyState icon={<ClipboardCheck size={20} />} title="No cases in this snapshot" description="Categories appear once case records are available." />
      ) : (
        <ul className="case-category-list" aria-label="Loaded cases by category">
          {shown.map(item => (
            <li key={item.category} className="case-category-row">
              <div className="case-category-row__heading">
                <span className="case-category-row__label">{item.category}</span>
                <span className="case-category-row__count">{item.count} {item.count === 1 ? 'case' : 'cases'}</span>
              </div>
              <span className="case-category-row__track" aria-hidden="true">
                <span className="case-category-row__fill" style={{ width: `${item.count / largest * 100}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {categories.length > shown.length ? (
        <p className="muted-note">Showing the {shown.length} largest of {categories.length} categories.</p>
      ) : null}
      {noteVisible ? (
        <footer className="case-category-note" id={noteId} aria-label="Case category explanation">
          <Info size={16} aria-hidden="true" />
          <p>These are CRM case categories, not the request types used to compose test emails. Counts reflect the loaded snapshot.</p>
          <IconButton label="Dismiss category note" icon={<X size={14} />} onClick={dismissNote} />
        </footer>
      ) : null}
    </Card>
  )
}
