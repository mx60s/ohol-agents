// MTS: dump every object (including generated use/variable dummies) and every
// transition (including generated category transitions) as JSON.
//
// Included into OneLife/server/server.cpp by patches/dump-game-data.patch and
// triggered with env OHOL_DUMP_GAME_DATA=<output path>. Runs after the object,
// category, and transition banks are loaded, then the server exits. Since it
// runs inside the server binary, object IDs match the wire protocol exactly.

#include <stdio.h>

static FILE *mtsOut = NULL;

static void mtsPrintJSONString( const char *s ) {
    fputc( '"', mtsOut );
    for( const char *c = s; c != NULL && *c != '\0'; c++ ) {
        unsigned char u = (unsigned char)*c;
        if( u == '"' || u == '\\' ) { fputc( '\\', mtsOut ); fputc( u, mtsOut ); }
        else if( u == '\n' ) { fputs( "\\n", mtsOut ); }
        else if( u == '\r' ) { fputs( "\\r", mtsOut ); }
        else if( u == '\t' ) { fputs( "\\t", mtsOut ); }
        else if( u < 0x20 ) { fprintf( mtsOut, "\\u%04x", u ); }
        else { fputc( u, mtsOut ); }
        }
    fputc( '"', mtsOut );
    }


static void mtsDumpGameData( const char *inPath ) {
    mtsOut = fopen( inPath, "w" );
    if( mtsOut == NULL ) {
        printf( "mtsDumpGameData: can't open %s\n", inPath );
        return;
        }

    int maxID = getMaxObjectID();

    fprintf( mtsOut, "{\n\"maxObjectID\": %d,\n\"objects\": [\n", maxID );

    char first = true;
    for( int id = 1; id <= maxID; id++ ) {
        ObjectRecord *o = getObject( id );
        if( o == NULL ) {
            continue;
            }
        if( ! first ) fprintf( mtsOut, ",\n" );
        first = false;

        int parent = 0;
        if( o->isUseDummy ) parent = o->useDummyParent;
        else if( o->isVariableDummy ) parent = o->variableDummyParent;

        fprintf( mtsOut, "{\"id\":%d,\"name\":", o->id );
        mtsPrintJSONString( o->description );
        fprintf( mtsOut, ",\"parent\":%d,\"useIndex\":%d,\"numUses\":%d"
                ",\"food\":%d,\"heat\":%d,\"rValue\":%.3f"
                ",\"permanent\":%d,\"containable\":%d,\"containSize\":%.2f"
                ",\"numSlots\":%d,\"slotSize\":%.2f,\"clothing\":\"%c\""
                ",\"blocksWalking\":%d,\"deadlyDistance\":%d"
                ",\"useDistance\":%d,\"minPickupAge\":%d"
                ",\"person\":%d,\"floor\":%d,\"mapChance\":%.4f"
                ",\"speedMult\":%.2f,\"writable\":%d,\"written\":%d"
                ",\"deathMarker\":%d,\"biomes\":[",
                parent,
                o->isUseDummy ? o->thisUseDummyIndex : -1,
                o->numUses,
                o->foodValue, o->heatValue, o->rValue,
                o->permanent, o->containable, o->containSize,
                o->numSlots, o->slotSize,
                o->clothing == '\0' ? 'n' : o->clothing,
                o->blocksWalking, o->deadlyDistance,
                o->useDistance, o->minPickupAge,
                o->person, o->floor, o->mapChance,
                o->speedMult, o->writable, o->written,
                o->deathMarker );
        for( int b = 0; b < o->numBiomes; b++ ) {
            fprintf( mtsOut, "%s%d", b > 0 ? "," : "", o->biomes[b] );
            }
        fprintf( mtsOut, "]}" );
        }

    fprintf( mtsOut, "\n],\n\"transitions\": [\n" );

    // each transition is listed under its actor (if actor > 0) and under its
    // target; emit it only from the list that owns it so it appears once
    first = true;
    for( int id = 0; id <= maxID; id++ ) {
        SimpleVector<TransRecord*> *uses = getAllUses( id );
        if( uses == NULL ) {
            continue;
            }
        for( int i = 0; i < uses->size(); i++ ) {
            TransRecord *t = uses->getElementDirect( i );
            int owner = ( t->actor > 0 ) ? t->actor : t->target;
            if( owner != id ) {
                continue;
                }

            if( ! first ) fprintf( mtsOut, ",\n" );
            first = false;
            fprintf( mtsOut, "[%d,%d,%d,%d,%d,%d,%d,%d,%d]",
                    t->actor, t->target, t->newActor, t->newTarget,
                    t->autoDecaySeconds, t->lastUseActor, t->lastUseTarget,
                    t->move, t->epochAutoDecay );
            }
        }

    fprintf( mtsOut, "\n],\n\"transitionFields\": [\"actor\",\"target\",\"newActor\","
            "\"newTarget\",\"autoDecaySeconds\",\"lastUseActor\","
            "\"lastUseTarget\",\"move\",\"epochAutoDecay\"]\n}\n" );

    fclose( mtsOut );
    mtsOut = NULL;
    printf( "mtsDumpGameData: wrote %s\n", inPath );
    }
