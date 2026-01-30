'use client';

import { useState, useRef, useEffect } from 'react';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { CategoryMapping } from '@/lib/import';

interface CategoryMappingRowProps {
  mapping: CategoryMapping;
  categoryOptions: Array<{ value: string; label: string }>;
  parentCategoryOptions: Array<{ value: string; label: string }>;
  onMappingChange: (update: Partial<CategoryMapping>) => void;
  formatCategoryPath: (path: string) => string;
  isHighlighted?: boolean;
}

export function CategoryMappingRow({
  mapping,
  categoryOptions,
  parentCategoryOptions,
  onMappingChange,
  formatCategoryPath,
  isHighlighted = false,
}: CategoryMappingRowProps) {
  // Local state for the "create new" input - only syncs on blur
  const [localCreateNew, setLocalCreateNew] = useState(mapping.createNew || '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync from parent if mapping changes externally (e.g., reset)
  useEffect(() => {
    if (mapping.createNew !== undefined && mapping.createNew !== localCreateNew) {
      setLocalCreateNew(mapping.createNew || '');
    }
  }, [mapping.createNew]);

  const handleCategorySelect = (categoryId: string) => {
    onMappingChange({
      categoryId: categoryId || undefined,
      createNew: undefined,
      parentCategoryId: undefined,
    });
    setLocalCreateNew('');
  };

  const handleCreateNewBlur = () => {
    const value = localCreateNew.trim();
    if (value !== (mapping.createNew || '')) {
      onMappingChange({
        categoryId: undefined,
        createNew: value || undefined,
      });
    }
  };

  const handleParentCategorySelect = (parentCategoryId: string) => {
    onMappingChange({
      parentCategoryId: parentCategoryId || undefined,
    });
  };

  // Show parent selector if local input has content (immediate feedback)
  const showParentSelector = localCreateNew.trim().length > 0;

  return (
    <div
      className={
        isHighlighted
          ? 'border-2 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4'
          : 'border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-lg p-3'
      }
    >
      {isHighlighted ? (
        <>
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">
            {formatCategoryPath(mapping.originalName)}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Map to existing"
              options={categoryOptions}
              value={mapping.categoryId || ''}
              onChange={(e) => handleCategorySelect(e.target.value)}
            />
            <div>
              <Input
                ref={inputRef}
                label="Or create new"
                placeholder="New category name"
                value={localCreateNew}
                onChange={(e) => setLocalCreateNew(e.target.value)}
                onBlur={handleCreateNewBlur}
              />
              {showParentSelector && (
                <div className="mt-2">
                  <Select
                    label="Parent category"
                    options={parentCategoryOptions}
                    value={mapping.parentCategoryId || ''}
                    onChange={(e) => handleParentCategorySelect(e.target.value)}
                  />
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap min-w-[200px]">
            {formatCategoryPath(mapping.originalName)}
          </span>
          <span className="text-gray-400">→</span>
          <Select
            options={categoryOptions}
            value={mapping.categoryId || ''}
            onChange={(e) => handleCategorySelect(e.target.value)}
            className="flex-1"
          />
        </div>
      )}
    </div>
  );
}
