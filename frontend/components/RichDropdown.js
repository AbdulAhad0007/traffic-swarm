'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';

/**
 * RichDropdown: A modern, responsive dropdown with icons, badges, descriptions,
 * and optional live search filtering.
 */
export default function RichDropdown({
  options = [],
  value,
  onChange,
  placeholder = 'Select option...',
  label,
  icon: Icon,
  className = '',
  searchable = false,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dropdownRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find(o => (typeof o === 'string' ? o === value : o.value === value));

  const filteredOptions = options.filter(o => {
    if (!query) return true;
    const text = typeof o === 'string' ? o : `${o.label || o.value} ${o.sub || ''} ${o.badge || ''}`;
    return text.toLowerCase().includes(query.toLowerCase());
  });

  const getOptionLabel = opt => (typeof opt === 'string' ? opt : opt.label || opt.value);
  const getOptionValue = opt => (typeof opt === 'string' ? opt : opt.value);
  const getOptionSub = opt => (typeof opt === 'object' ? opt.sub : null);
  const getOptionBadge = opt => (typeof opt === 'object' ? opt.badge : null);
  const getOptionIcon = opt => (typeof opt === 'object' ? opt.icon : null);

  return (
    <div className={`rich-dropdown-wrap ${className}`} ref={dropdownRef}>
      {label && <label className="rich-dropdown-label">{label}</label>}

      <button
        type="button"
        className={`rich-dropdown-trigger ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="trigger-left">
          {Icon && <Icon size={16} className="trigger-icon" />}
          {selectedOption ? (
            <div className="selected-content">
              <span className="selected-label">{getOptionLabel(selectedOption)}</span>
              {getOptionBadge(selectedOption) && (
                <span className="selected-badge">{getOptionBadge(selectedOption)}</span>
              )}
            </div>
          ) : (
            <span className="trigger-placeholder">{placeholder}</span>
          )}
        </div>

        <ChevronDown size={16} className={`chevron-icon ${open ? 'rotated' : ''}`} />
      </button>

      {open && (
        <div className="rich-dropdown-menu" role="listbox">
          {searchable && options.length > 4 && (
            <div className="dropdown-search-box">
              <Search size={14} className="search-icon" />
              <input
                type="text"
                placeholder="Search..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                autoFocus
                onClick={e => e.stopPropagation()}
              />
            </div>
          )}

          <div className="dropdown-options-scroll">
            {filteredOptions.length === 0 ? (
              <div className="no-options-found">No matching options</div>
            ) : (
              filteredOptions.map(opt => {
                const optVal = getOptionValue(opt);
                const isSelected = optVal === value;
                const OptIcon = getOptionIcon(opt);
                const optBadge = getOptionBadge(opt);
                const optSub = getOptionSub(opt);

                return (
                  <div
                    key={optVal}
                    className={`rich-option-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      onChange(optVal);
                      setOpen(false);
                      setQuery('');
                    }}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <div className="option-info">
                      <div className="option-headline">
                        {OptIcon && <OptIcon size={14} className="option-icon" />}
                        <span className="option-label">{getOptionLabel(opt)}</span>
                        {optBadge && <span className="option-badge">{optBadge}</span>}
                      </div>
                      {optSub && <p className="option-sub">{optSub}</p>}
                    </div>

                    {isSelected && <Check size={16} className="option-check" />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
