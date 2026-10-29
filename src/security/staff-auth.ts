/**
 * Staff authorization is by exact group id. Only members can post in the staff group, so by default
 * every human member is staff. If an explicit allow-list of numeric user ids is configured it further
 * restricts staff to those ids. Usernames are never used.
 */
export interface StaffAuth {
  isStaffGroup(chatId: string): boolean;
  isAuthorizedStaff(userId: string): boolean;
}

export function createStaffAuth(staffGroupId: string, allowedStaffIds: readonly string[] = []): StaffAuth {
  const allowed = new Set(allowedStaffIds);
  return {
    isStaffGroup: (chatId) => chatId === staffGroupId,
    isAuthorizedStaff: (userId) => allowed.size === 0 || allowed.has(userId),
  };
}
