export function cleanupPathIsReferenced(db, filePath) {
  const referencedByOrganizationDocument = (db.organizationDocuments || []).some((document) => {
    if (document.filePath !== filePath) return false;
    const organization = (db.organizations || []).find((row) => row.id === document.organizationId);
    return !document.cleanedAt || organization?.currentDocumentId === document.id;
  });
  const referencedByLeaderDocument = (db.organizationLeaderDocuments || []).some((document) => (
    document.filePath === filePath && !document.cleanedAt
  ));
  return referencedByOrganizationDocument
    || referencedByLeaderDocument
    || (db.certificates || []).some((row) => row.filePath === filePath)
    || (db.registrationSubmissionAssets || []).some((row) => row.filePath === filePath && !row.cleanedAt);
}
