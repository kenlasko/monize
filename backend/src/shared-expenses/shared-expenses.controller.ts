import { SharedFinanceService } from "./shared-finance.service";
import { SharedCollaborationService } from "./shared-collaboration.service";
import { UseInterceptors } from "@nestjs/common";
import { SharedNotificationsInterceptor } from "./shared-notifications.interceptor";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { SharedGroupsService } from "./shared-groups.service";
import { SharedEntriesService } from "./shared-entries.service";
import { SharedInvitationsService } from "./shared-invitations.service";
import { SharedMembershipsService } from "./shared-memberships.service";
import { SharedPeopleService } from "./shared-people.service";
import {
  ChangeSharedMembershipDto,
  ChangeSharedParticipantDto,
  ClaimSharedInvitationDto,
  CreateSharedGroupDto,
  LinkSharedPersonDto,
  SharedInvitationDto,
  SharedMuteDto,
  SharedPersonDto,
  UpdateSharedGroupDto,
} from "./dto/shared-group.dto";
import {
  ReverseSharedEntryDto,
  SharedEntryDto,
  SharedListDto,
} from "./dto/shared-entry.dto";
import { SharedCommandDto } from "./dto/shared-command.dto";

type SharedRequest = { user: { id: string } };

@ApiTags("Shared expenses")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@UseInterceptors(SharedNotificationsInterceptor)
@Controller("shared-expenses")
export class SharedExpensesController {
  constructor(
    private readonly collaboration: SharedCollaborationService,
    private readonly groups: SharedGroupsService,
    private readonly finance: SharedFinanceService,
    private readonly entries: SharedEntriesService,
    private readonly invitations: SharedInvitationsService,
    private readonly memberships: SharedMembershipsService,
    private readonly people: SharedPeopleService,
  ) {}

  @Get("overview")
  overview(@Request() req: SharedRequest) {
    return this.groups.overview(req.user.id);
  }

  @Get("private-finances")
  privateFinances(@Request() req: SharedRequest) {
    return this.finance.privateGroups(req.user.id);
  }

  @Get("private-finances/postings/:postingId")
  postingLocation(
    @Request() req: SharedRequest,
    @Param("postingId", ParseUUIDPipe) postingId: string,
  ) {
    return this.finance.postingLocation(req.user.id, postingId);
  }

  @Delete("groups/:groupId")
  removeEmpty(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SharedCommandDto,
  ) {
    return this.groups.removeEmpty(req.user.id, groupId, dto);
  }

  @Get("groups/:groupId/activity")
  activity(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Query() query: SharedListDto,
  ) {
    return this.collaboration.activity(req.user.id, groupId, query.offset);
  }

  @Post("groups/:groupId/participants/:participantId/remind")
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  remind(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("participantId", ParseUUIDPipe) participantId: string,
    @Body() dto: SharedCommandDto,
  ) {
    return this.collaboration.remind(req.user.id, groupId, participantId, dto);
  }

  @Get("groups")
  list(@Request() req: SharedRequest) {
    return this.groups.list(req.user.id);
  }

  @Post("groups")
  create(@Request() req: SharedRequest, @Body() dto: CreateSharedGroupDto) {
    return this.groups.create(req.user.id, dto);
  }

  @Get("groups/:groupId")
  detail(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Query() query: SharedListDto,
  ) {
    return this.groups.detail(req.user.id, groupId, query.offset, query);
  }

  @Get("groups/:groupId/export")
  export(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
  ) {
    return this.groups.export(req.user.id, groupId);
  }

  @Patch("groups/:groupId")
  update(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: UpdateSharedGroupDto,
  ) {
    return this.groups.update(req.user.id, groupId, dto);
  }

  @Post("groups/:groupId/participants")
  addParticipant(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: ChangeSharedParticipantDto,
  ) {
    return this.groups.participant(req.user.id, groupId, undefined, dto);
  }

  @Patch("groups/:groupId/participants/:participantId")
  updateParticipant(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("participantId", ParseUUIDPipe) participantId: string,
    @Body() dto: ChangeSharedParticipantDto,
  ) {
    return this.groups.participant(req.user.id, groupId, participantId, dto);
  }

  @Get("groups/:groupId/entries/:entryId")
  entry(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
  ) {
    return this.entries.get(req.user.id, groupId, entryId);
  }

  @Post("groups/:groupId/entries/preview")
  preview(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SharedEntryDto,
  ) {
    return this.entries.preview(req.user.id, groupId, dto);
  }

  @Post("groups/:groupId/entries/:entryId/preview")
  previewEdit(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() dto: SharedEntryDto,
  ) {
    return this.entries.preview(req.user.id, groupId, dto, entryId);
  }

  @Post("groups/:groupId/entries")
  createEntry(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SharedEntryDto,
  ) {
    return this.entries.save(req.user.id, groupId, dto);
  }

  @Patch("groups/:groupId/entries/:entryId")
  updateEntry(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() dto: SharedEntryDto,
  ) {
    return this.entries.save(req.user.id, groupId, dto, entryId);
  }

  @Post("groups/:groupId/entries/:entryId/reverse")
  reverseEntry(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() dto: ReverseSharedEntryDto,
  ) {
    return this.entries.reverse(req.user.id, groupId, entryId, dto);
  }

  @Get("groups/:groupId/invitations")
  listInvitations(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
  ) {
    return this.invitations.list(req.user.id, groupId);
  }

  @Post("groups/:groupId/invitations")
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  invite(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SharedInvitationDto,
  ) {
    return this.invitations.create(req.user.id, groupId, dto);
  }

  @Post("groups/:groupId/invitations/:invitationId/revoke")
  revokeInvitation(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("invitationId", ParseUUIDPipe) invitationId: string,
    @Body() dto: SharedCommandDto,
  ) {
    return this.invitations.revoke(req.user.id, groupId, invitationId, dto);
  }

  @Post("invitations/inspect")
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  inspect(
    @Request() req: SharedRequest,
    @Body() dto: ClaimSharedInvitationDto,
  ) {
    return this.invitations.inspect(req.user.id, dto.token);
  }

  @Post("invitations/claim")
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  claim(@Request() req: SharedRequest, @Body() dto: ClaimSharedInvitationDto) {
    return this.invitations.claim(req.user.id, dto.token);
  }

  @Patch("groups/:groupId/memberships/:participantId")
  membership(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("participantId", ParseUUIDPipe) participantId: string,
    @Body() dto: ChangeSharedMembershipDto,
  ) {
    return this.memberships.change(req.user.id, groupId, participantId, dto);
  }

  @Post("groups/:groupId/ownership/:requestId/accept")
  acceptOwnership(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("requestId", ParseUUIDPipe) requestId: string,
    @Body() dto: SharedCommandDto,
  ) {
    return this.memberships.acceptOwnership(
      req.user.id,
      groupId,
      requestId,
      dto,
    );
  }

  @Patch("groups/:groupId/mute")
  mute(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SharedMuteDto,
  ) {
    return this.memberships.mute(req.user.id, groupId, dto.muted);
  }

  @Post("groups/:groupId/leave")
  leave(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
  ) {
    return this.memberships.leave(req.user.id, groupId);
  }

  @Get("people")
  listPeople(@Request() req: SharedRequest) {
    return this.people.list(req.user.id);
  }

  @Post("people")
  createPerson(@Request() req: SharedRequest, @Body() dto: SharedPersonDto) {
    return this.people.save(req.user.id, dto);
  }

  @Patch("people/:personId")
  updatePerson(
    @Request() req: SharedRequest,
    @Param("personId", ParseUUIDPipe) personId: string,
    @Body() dto: SharedPersonDto,
  ) {
    return this.people.save(req.user.id, dto, personId);
  }

  @Delete("people/:personId")
  deletePerson(
    @Request() req: SharedRequest,
    @Param("personId", ParseUUIDPipe) personId: string,
  ) {
    return this.people.remove(req.user.id, personId);
  }

  @Post("groups/:groupId/people")
  linkPerson(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: LinkSharedPersonDto,
  ) {
    return this.people.link(req.user.id, groupId, dto);
  }
}
