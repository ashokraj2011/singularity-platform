export interface InitiativeDTO {
  id: string
  title: string
  description?: string
  status: string
  createdById: string
  owners: InitiativeOwnerDTO[]
  createdAt: string
  updatedAt: string
}

export interface InitiativeOwnerDTO {
  userId: string
  displayName: string
  email: string
}

export interface InitiativeDocumentDTO {
  id: string
  initiativeId: string
  documentId: string
  createdAt: string
}
