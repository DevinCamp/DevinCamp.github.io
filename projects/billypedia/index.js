/* global $ _ opspark */
$(document).ready(function() {
    $.getJSON('data.json', function (data) {
        // YOUR CODE BELOW HERE //
    //   $('.bio').css('color', 'blue').css('font-style', 'italic');
    //   $('#section-bio').css('background-color', 'coral').css('border-radius', '100px');
    //   $('.quote').css('color', 'blue').css('font-style', 'italic');
    //   $('#section-quotes').css('background-color', 'coral').css('border-radius', '10000px');
    //   $('#section-bio').css('border', '2px solid blue').css('border-radius', '10px').css('margin', '10px').css('padding', '5px');
    //   $('#section-praise').css('border', '2px solid white').css('border-radius', '10px').css('margin', '10px').css('padding', '5px');
    //   $('#section-quotes').css('border', '2px solid black').css('border-radius', '10px').css('margin', '10px').css('padding', '5px');
     
        // uncomment this to inspect all available data; delete when done //
         //console.log(data);
        
        // EXAMPLE: Looping over top rated recordings; replace with your code //
                
       
            
            
         let recordings = data.discography.recordings;
         let topRated = data.discography.topRated;
         $('<section>').attr('id','section-rider').append($('<h3>')).text('Billy\'s Rider').appendTo($('#sections'));
        
                                                         // TOP RATED //
         let $section = $('<section>').attr('id', 'top-rated');
         
         let $topRatedImage = $('<img>').attr('id', 'top-rated-image').attr('class', 'image').attr('src', topRated[0].art);
         $topRatedImage.appendTo('#sidebar');
        
         _.map(topRated, function(recording) {
             
             return $section.append($('<li>').attr('class', 'top-recording')
                 .append($('<div>').text("Title: " + recording.title))
                 .append($('<div>').text("Artist: " + recording.artist))
                 .append($('<div>').text("Release: " + recording.release))
                 .append($('<div>').text("Year: " + recording.year))
                 .attr('src', recording.art)).appendTo('#sidebar');
                 
                 
        });
                                                        // clicks on list item of top rated//
       $('.top-recording').on('click', function(e) {
                if ($(e.target).parent().hasClass('top-recording')) { 
                return $('#top-rated-image').attr('src', $(this).attr('src'));
                }
            });
       
        
        

         let $div = $('<div>').attr('id', 'image-container-recording').attr('class', 'image-container');
         $div.appendTo('#sidebar');
         
         let $recordingImage = $('<img>').attr('id', 'recording-image').attr('class', 'image').attr('src', recordings[0].art);
         $div.append($recordingImage);

         let $sectionrec = $('<section>').attr('id', 'section-recordings');
         $sectionrec.appendTo('#sidebar');

         let $sectionlist = $('<ul>').attr('id', 'list-recording');
         $sectionlist.appendTo($('#section-recordings'));

                                                             //RECORDINGS
    _.map(recordings, function(recording) {
           
            return $sectionlist.append($('<li>').attr('class', 'recording')
                 .append($('<div>').text("Title: " + recording.title))
                 .append($('<div>').text("Artist: " + recording.artist))
                 .append($('<div>').text("Release: " + recording.release))
                 .append($('<div>').text("Year: " + recording.year))
                 .attr('src', recording.art));
                 
         });
         
         
         
            $('.recording').on('click', function(e) {
                if ($(e.target).parent().hasClass('recording')) { 
                return $('#recording-image').attr('src', $(this).attr('src'));
                }
            });
           
       
        
        
                                                        // Image change  //
         let count = 0;
         let $images = data.images.billy;

        
        $('#image-billy').on('click', function() {
             $('#image-billy').fadeOut(400, function() {
                     count === $images.length - 1 ? $('#image-billy').attr('src', $images[count = 0]) : count++;
                     return $('#image-billy').attr('src', $images[count]);
                 })
                 .fadeIn(500);
         });
        
        
        
        
        
          let $img = _.map(recordings,function(recording) {
            return recording.art;
        });
        console.log($img)
        
        
          
          
          
         
         
         
                                                    //  Table  //
 var createTable = function(list) {
     var createRow = function(item) {
         var $row = $("<tr>");
         var $drum = $("<td>").text(item.type);
         var $dimension = $("<td>").text(item.desc);
         $row.append($drum);
         $row.append($dimension);
         return $row;
     };
     var $table = $("<table>");
     var $rows = list.map(createRow);
     $table.append($rows);
     return $table;
 };

 createTable(data.rider).appendTo("#section-rider");  
        
        
       $('.bio').css('color', 'blue').css('font-style', 'italic');
       $('#section-bio').css('background-color', 'coral').css('border-radius', '100px');
       $('.quote').css('color', 'blue').css('font-style', 'italic');
       $('#section-quotes').css('background-color', 'coral').css('border-radius', '10000px');
       $('#section-bio').css('border', '2px solid blue').css('border-radius', '10px').css('margin', '10px').css('padding', '5px');
       $('#section-praise').css('border', '2px solid white').css('border-radius', '10px').css('margin', '10px').css('padding', '5px');
       $('#section-quotes').css('border', '2px solid black').css('border-radius', '10px').css('margin', '10px').css('padding', '5px');
       $('#section-rider').css('display', 'block');
      $('td').css('border', '2px').css('border-style', 'solid').css('color', 'skyblue');
      $('ul').css('width', '200px');
      $('li').css('display', 'block');
      $('.recording').css('border-top', '2px').css('border-style', 'solid');
      $('#section-rider').css('border-top', '2px').css('border-style', 'solid');
      $('.top-recording').css('border-top', '2px').css('border-style', 'solid');
      
 
 
 

 
 
        // YOUR CODE ABOVE HERE //
    })
    .fail(function() { console.log('getJSON on discography failed!'); });
});





