import { Repository } from "typeorm";
import { Category } from "../categories/entities/category.entity";

/**
 * Resolves a list of category IDs to include all their descendant categories.
 * Used by transaction filtering to include sub-categories when filtering by parent.
 */
export async function getAllCategoryIdsWithChildren(
  categoriesRepository: Repository<Category>,
  userId: string,
  categoryIds: string[],
): Promise<string[]> {
  const categories = await categoriesRepository.find({
    where: { userId },
    select: ["id", "parentId"],
  });

  const result = new Set<string>();
  const addWithChildren = (parentId: string) => {
    result.add(parentId);
    for (const cat of categories) {
      if (cat.parentId === parentId && !result.has(cat.id)) {
        addWithChildren(cat.id);
      }
    }
  };

  for (const id of categoryIds) {
    addWithChildren(id);
  }

  return [...result];
}
